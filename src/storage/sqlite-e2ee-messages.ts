import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

import {
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  RETENTION_DAYS,
} from "../domain/contracts.js";
import { IdempotencyConflictError, UnknownAgentError } from "../domain/errors.js";
import type { Instant } from "../domain/value-objects.js";
import {
  type PublicAgentKeyBundleDto,
  PublicAgentKeyBundleDtoSchema,
  type PublicAgentSigningChainDto,
  PublicAgentSigningChainDtoSchema,
} from "../e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type AcknowledgeEncryptedMessagesOutput,
  AcknowledgeEncryptedMessagesOutputSchema,
  type EncryptedMessageReadReceiptDto,
  type EncryptedMessageDto,
  EncryptedMessageDtoSchema,
  type GetEncryptedMessagesInput,
  GetEncryptedMessagesInputSchema,
  type GetInboxSummaryInput,
  GetInboxSummaryInputSchema,
  type GetInboxSummaryOutput,
  GetInboxSummaryOutputSchema,
  type PutEncryptedMessageInput,
  PutEncryptedMessageInputSchema,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
} from "../e2ee/wire-tools.js";
import {
  e2eeEnvelopeJson,
  encryptedCiphertextBytes,
  type StoredEncryptionClaim,
  senderChainFromBundle,
  validateEnvelopeForClaim,
} from "./e2ee-store-validation.js";
import {
  type SqliteE2eeClaimRow,
  SqliteE2eeClaimRowSchema,
  type SqliteE2eeMessageRow,
  SqliteE2eeMessageRowSchema,
  type SqliteE2eeVersionRow,
  SqliteE2eeVersionRowSchema,
} from "./sqlite-e2ee-rows.js";
import { updateSqliteE2eeUsage } from "./sqlite-e2ee-usage.js";
import { readSqliteInboxPage } from "./sqlite-inbox-page.js";

function agentGeneration(database: Database, agentId: string): number {
  const raw: unknown = database
    .query<unknown, [string]>(
      "SELECT generation FROM agents WHERE agent_id = ? AND closed_at IS NULL",
    )
    .get(agentId);
  if (raw === null) throw new UnknownAgentError(agentId);
  if (typeof raw !== "object") throw new Error("Stored agent generation is invalid");
  const generation: unknown = Reflect.get(raw, "generation");
  if (typeof generation !== "number" && typeof generation !== "bigint") {
    throw new Error("Stored agent generation is invalid");
  }
  return Number(generation);
}

function storedClaim(row: SqliteE2eeClaimRow): StoredEncryptionClaim {
  const request: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse(
    JSON.parse(row.request_json),
  );
  const claim: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
    JSON.parse(row.claim_json),
  );
  return {
    claim,
    recipientGeneration: row.recipient_generation,
    request,
    senderGeneration: row.sender_generation,
  };
}

function claimRow(database: Database, claimId: string): SqliteE2eeClaimRow {
  const raw: unknown = database
    .query<unknown, [string]>(`
      SELECT broadcast_id, claim_json, consumed_at, expires_at,
        recipient_generation, request_json, sender_generation
      FROM e2ee_claims WHERE claim_id = ?
    `)
    .get(claimId);
  if (raw === null) throw new Error("Encryption claim is unavailable or expired");
  return SqliteE2eeClaimRowSchema.parse(raw);
}

function senderBundle(
  database: Database,
  senderId: string,
  generation: number,
): PublicAgentKeyBundleDto {
  const raw: unknown = database
    .query<unknown, [string, number]>(`
      SELECT bundle_json FROM e2ee_key_bundles
      WHERE agent_id = ? AND agent_generation = ?
    `)
    .get(senderId, generation);
  if (raw === null || typeof raw !== "object") {
    throw new Error("Sender has no current E2E signing bundle");
  }
  const bundleJson: unknown = Reflect.get(raw, "bundle_json");
  if (typeof bundleJson !== "string") throw new Error("Stored E2E sender bundle is invalid");
  return PublicAgentKeyBundleDtoSchema.parse(JSON.parse(bundleJson));
}

function messageFromRow(row: SqliteE2eeMessageRow): EncryptedMessageDto {
  return EncryptedMessageDtoSchema.parse({
    envelope: JSON.parse(row.envelope_json),
    read_at: row.read_at,
    sender_chain: JSON.parse(row.sender_chain_json),
    tenant_sequence: row.sequence,
  });
}

function existingMessage(
  database: Database,
  senderId: string,
  idempotencyKey: string,
): SqliteE2eeMessageRow | null {
  const raw: unknown = database
    .query<unknown, [string, string]>(`
      SELECT sequence, envelope_json, sender_chain_json, read_at
      FROM e2ee_messages WHERE sender_id = ? AND idempotency_key = ?
    `)
    .get(senderId, idempotencyKey);
  return raw === null ? null : SqliteE2eeMessageRowSchema.parse(raw);
}

function putOutput(row: SqliteE2eeMessageRow, duplicate: boolean): PutEncryptedMessageOutput {
  return PutEncryptedMessageOutputSchema.parse({
    duplicate,
    message: messageFromRow(row),
    retention_days: RETENTION_DAYS,
    status: "stored",
  });
}

export function existingSqliteEncryptedMessageOutput(
  database: Database,
  inputValue: unknown,
): PutEncryptedMessageOutput | null {
  const input: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse(inputValue);
  const prior: SqliteE2eeMessageRow | null = existingMessage(
    database,
    input.envelope.header.sender_id,
    input.envelope.header.idempotency_key,
  );
  if (prior === null) return null;
  if (prior.envelope_json !== e2eeEnvelopeJson(input.envelope)) {
    throw new IdempotencyConflictError(input.envelope.header.idempotency_key);
  }
  return putOutput(prior, true);
}

function requireMatchingSenderChain(
  database: Database,
  stored: StoredEncryptionClaim,
  input: PutEncryptedMessageInput,
): PublicAgentSigningChainDto {
  if (
    agentGeneration(database, stored.request.sender_id) !== stored.senderGeneration ||
    agentGeneration(database, stored.request.recipient_id) !== stored.recipientGeneration
  ) {
    throw new Error("Encryption claim agent generation changed");
  }
  const bundle: PublicAgentKeyBundleDto = senderBundle(
    database,
    stored.request.sender_id,
    stored.senderGeneration,
  );
  if (
    bundle.root_key_id !== input.envelope.header.sender_root_key_id ||
    bundle.agent_certificate.signing_key_id !== input.envelope.header.sender_agent_key_id
  ) {
    throw new Error("Encrypted envelope sender does not match its published signing bundle");
  }
  return senderChainFromBundle(bundle);
}

export function putSqliteEncryptedMessage(
  database: Database,
  tenantId: string,
  inputValue: unknown,
  now: Instant,
): PutEncryptedMessageOutput {
  const input: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse(inputValue);
  const serializedEnvelope: string = e2eeEnvelopeJson(input.envelope);
  database.exec("BEGIN IMMEDIATE");
  try {
    const prior: SqliteE2eeMessageRow | null = existingMessage(
      database,
      input.envelope.header.sender_id,
      input.envelope.header.idempotency_key,
    );
    if (prior !== null) {
      if (prior.envelope_json !== serializedEnvelope) {
        throw new IdempotencyConflictError(input.envelope.header.idempotency_key);
      }
      database.exec("COMMIT");
      return putOutput(prior, true);
    }
    const row: SqliteE2eeClaimRow = claimRow(database, input.claim_id);
    if (
      row.broadcast_id !== null ||
      row.consumed_at !== null ||
      row.expires_at <= now.toISOString()
    ) {
      throw new Error("Encryption claim is unavailable or expired");
    }
    const stored: StoredEncryptionClaim = storedClaim(row);
    validateEnvelopeForClaim(input.envelope, stored, tenantId, null, now.toISOString());
    const senderChain: PublicAgentSigningChainDto = PublicAgentSigningChainDtoSchema.parse(
      requireMatchingSenderChain(database, stored, input),
    );
    const ciphertextBytes: number = encryptedCiphertextBytes(input.envelope);
    const header: PutEncryptedMessageInput["envelope"]["header"] = input.envelope.header;
    const insert: Statement<
      unknown,
      [
        string,
        string,
        string,
        number,
        string,
        number,
        string | null,
        string,
        number,
        string,
        string,
        number,
        string,
        string,
      ]
    > = database.query(`
      INSERT INTO e2ee_messages(
        message_id, thread_id, sender_id, sender_generation, recipient_id,
        recipient_generation, broadcast_id, idempotency_key, pair_counter,
        envelope_json, sender_chain_json, ciphertext_bytes, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      header.message_id,
      header.thread_id,
      header.sender_id,
      stored.senderGeneration,
      header.recipient_id,
      stored.recipientGeneration,
      null,
      header.idempotency_key,
      header.pair_counter,
      serializedEnvelope,
      JSON.stringify(senderChain),
      ciphertextBytes,
      header.created_at,
      header.expires_at,
    );
    database
      .query<unknown, [string, string]>(`
        UPDATE e2ee_claims SET consumed_at = ? WHERE claim_id = ? AND consumed_at IS NULL
      `)
      .run(now.toISOString(), input.claim_id);
    updateSqliteE2eeUsage(database, {
      claimCount: -1,
      pendingBroadcastCount: 0,
      pendingCiphertextBytes: 0,
      pendingDeliveryCount: 0,
      publicPrekeyCount: 0,
      retainedCiphertextBytes: ciphertextBytes,
      retainedMessageCount: 1,
    });
    const inserted: SqliteE2eeMessageRow | null = existingMessage(
      database,
      header.sender_id,
      header.idempotency_key,
    );
    if (inserted === null) throw new Error("Stored encrypted message acknowledgement is missing");
    database.exec("COMMIT");
    return putOutput(inserted, false);
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getSqliteEncryptedMessages(
  database: Database,
  inputValue: unknown,
  now: Instant,
): EncryptedInboxOutput {
  const input: GetEncryptedMessagesInput = GetEncryptedMessagesInputSchema.parse(inputValue);
  const generation: number = agentGeneration(database, input.agent_id);
  const rows: unknown[] = readSqliteInboxPage(database, "encrypted", {
    afterSequence: input.after_sequence,
    agentId: input.agent_id,
    expiresAfter: now.toISOString(),
    generation,
    limit: input.limit,
    threadId: input.thread_id === undefined ? null : input.thread_id,
    unreadOnly: input.unread_only,
  });
  const messages: EncryptedMessageDto[] = rows.map(
    (row: unknown): EncryptedMessageDto => messageFromRow(SqliteE2eeMessageRowSchema.parse(row)),
  );
  return EncryptedInboxOutputSchema.parse({
    agent_id: input.agent_id,
    inbox_version: sqliteEncryptedInboxVersion(database, input.agent_id, generation, now),
    messages,
  });
}

export function acknowledgeSqliteEncryptedMessages(
  database: Database,
  inputValue: unknown,
  now: Instant,
): AcknowledgeEncryptedMessagesOutput {
  const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(inputValue);
  const generation: number = agentGeneration(database, input.agent_id);
  if (input.message_ids.length === 0) {
    return AcknowledgeEncryptedMessagesOutputSchema.parse({ receipts: [], updated: 0 });
  }
  const messageIds: string = JSON.stringify(input.message_ids);
  const mark: () => AcknowledgeEncryptedMessagesOutput = (): AcknowledgeEncryptedMessagesOutput => {
    database
      .query<unknown, [string, string, number, string, string]>(`
        UPDATE e2ee_messages SET read_at = COALESCE(read_at, ?)
        WHERE recipient_id = ? AND recipient_generation = ?
          AND message_id IN (SELECT value FROM json_each(?)) AND expires_at > ?
      `)
      .run(now.toISOString(), input.agent_id, generation, messageIds, now.toISOString());
    const raw: unknown[] = database
      .query<unknown, [string, number, string, string]>(`
        SELECT message_id, read_at FROM e2ee_messages
        WHERE recipient_id = ? AND recipient_generation = ?
          AND message_id IN (SELECT value FROM json_each(?)) AND expires_at > ?
        ORDER BY message_id ASC
      `)
      .all(input.agent_id, generation, messageIds, now.toISOString());
    const receipts: EncryptedMessageReadReceiptDto[] = z
      .array(z.strictObject({ message_id: z.string().uuid(), read_at: z.iso.datetime() }))
      .parse(raw);
    return AcknowledgeEncryptedMessagesOutputSchema.parse({ receipts, updated: receipts.length });
  };
  return database.transaction(mark).immediate();
}

export function markSqliteEncryptedMessagesRead(
  database: Database,
  inputValue: unknown,
  now: Instant,
): MarkMessagesReadOutput {
  const acknowledgement: AcknowledgeEncryptedMessagesOutput = acknowledgeSqliteEncryptedMessages(
    database,
    inputValue,
    now,
  );
  return MarkMessagesReadOutputSchema.parse({
    read_at: now.toISOString(),
    updated: acknowledgement.updated,
  });
}

export function sqliteEncryptedInboxVersion(
  database: Database,
  agentId: string,
  generation: number,
  now: Instant,
): number {
  const row: SqliteE2eeVersionRow = SqliteE2eeVersionRowSchema.parse(
    database
      .query<unknown, [string, number, string]>(`
        SELECT COALESCE(MAX(sequence), 0) AS version,
          MAX(sequence) AS newest_sequence,
          COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count
        FROM e2ee_messages
        WHERE recipient_id = ? AND recipient_generation = ? AND expires_at > ?
      `)
      .get(agentId, generation, now.toISOString()),
  );
  return row.version;
}

export function getSqliteEncryptedInboxSummary(
  database: Database,
  inputValue: unknown,
  now: Instant,
): GetInboxSummaryOutput {
  const input: GetInboxSummaryInput = GetInboxSummaryInputSchema.parse(inputValue);
  const generation: number = agentGeneration(database, input.agent_id);
  const row: SqliteE2eeVersionRow = SqliteE2eeVersionRowSchema.parse(
    database
      .query<unknown, [string, number, string]>(`
        SELECT COALESCE(MAX(sequence), 0) AS version,
          MAX(sequence) AS newest_sequence,
          COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count
        FROM e2ee_messages
        WHERE recipient_id = ? AND recipient_generation = ? AND expires_at > ?
      `)
      .get(input.agent_id, generation, now.toISOString()),
  );
  return GetInboxSummaryOutputSchema.parse({
    agent_id: input.agent_id,
    inbox_version: row.version,
    newest_sequence: row.newest_sequence,
    unread_count: row.unread_count,
  });
}
