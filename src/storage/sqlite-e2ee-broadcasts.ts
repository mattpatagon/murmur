import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { IdempotencyConflictError, UnknownAgentError } from "../domain/errors.js";
import type { Instant } from "../domain/value-objects.js";
import {
  type PublicAgentKeyBundleDto,
  PublicAgentKeyBundleDtoSchema,
  type PublicAgentSigningChainDto,
} from "../e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastInputSchema,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
  type PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryInputSchema,
  type PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedBroadcastDeliveryOutputSchema,
} from "../e2ee/wire-tools.js";
import {
  e2eeEnvelopeJson,
  encryptedCiphertextBytes,
  type StoredEncryptionClaim,
  senderChainFromBundle,
  validateEnvelopeForClaim,
} from "./e2ee-store-validation.js";
import { claimSqliteEncryptionPrekeyInTransaction } from "./sqlite-e2ee-keys.js";
import {
  type SqliteE2eeBroadcastRow,
  SqliteE2eeBroadcastRowSchema,
  type SqliteE2eeClaimRow,
  SqliteE2eeClaimRowSchema,
  type SqliteE2eeDeliveryRow,
  SqliteE2eeDeliveryRowSchema,
} from "./sqlite-e2ee-rows.js";
import { updateSqliteE2eeUsage } from "./sqlite-e2ee-usage.js";

const MAX_BROADCAST_RECIPIENTS: number = 100;
const PENDING_BROADCAST_MINUTES: number = 5;

type RecipientRow = { readonly agent_id: string; readonly generation: number };
const RecipientRowSchema: z.ZodType<RecipientRow> = z.strictObject({
  agent_id: z.string(),
  generation: z
    .union([z.number().int(), z.bigint()])
    .transform((value: number | bigint): number => Number(value)),
});

export function sqliteE2eeOpenAgentGeneration(database: Database, agentId: string): number {
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

function candidateRecipients(
  database: Database,
  input: PrepareEncryptedBroadcastInput,
  now: Instant,
): readonly RecipientRow[] {
  const repository: string | null = input.audience.repository ?? null;
  const machine: string | null = input.audience.machine ?? null;
  const raw: unknown[] = database
    .query<
      unknown,
      [string, string, string | null, string | null, string | null, string | null, number]
    >(`
      SELECT agent.agent_id, agent.generation
      FROM agents AS agent
      WHERE agent.agent_id <> ? AND agent.closed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM agent_sessions AS session
          WHERE session.agent_id = agent.agent_id
            AND session.generation = agent.generation
            AND session.ended_at IS NULL
            AND session.lease_expires_at > ?
        )
        AND (? IS NULL OR json_extract(agent.metadata_json, '$.repository') = ?)
        AND (? IS NULL OR json_extract(agent.metadata_json, '$.machine') = ?)
      ORDER BY agent.agent_id ASC LIMIT ?
    `)
    .all(
      input.sender_id,
      now.toISOString(),
      repository,
      repository,
      machine,
      machine,
      MAX_BROADCAST_RECIPIENTS + 1,
    );
  const recipients: RecipientRow[] = raw.map(
    (row: unknown): RecipientRow => RecipientRowSchema.parse(row),
  );
  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`Broadcasts are limited to ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  return recipients;
}

export function readSqliteE2eeBroadcast(
  database: Database,
  broadcastId: string,
): SqliteE2eeBroadcastRow {
  const raw: unknown = database
    .query<unknown, [string]>(`
      SELECT broadcast_id, committed_at, expires_at, recipient_count, request_json,
        sender_generation, sender_id, state, thread_id
      FROM e2ee_broadcasts WHERE broadcast_id = ?
    `)
    .get(broadcastId);
  if (raw === null) throw new Error("Encrypted broadcast is unavailable or expired");
  return SqliteE2eeBroadcastRowSchema.parse(raw);
}

function claimsForBroadcast(
  database: Database,
  broadcastId: string,
): ClaimEncryptionPrekeyOutput[] {
  const raw: unknown[] = database
    .query<unknown, [string]>(`
      SELECT claim_json FROM e2ee_claims
      WHERE broadcast_id = ? ORDER BY recipient_id ASC
    `)
    .all(broadcastId);
  return raw.map((row: unknown): ClaimEncryptionPrekeyOutput => {
    if (typeof row !== "object" || row === null) throw new Error("Stored E2E claim is invalid");
    const value: unknown = Reflect.get(row, "claim_json");
    if (typeof value !== "string") throw new Error("Stored E2E claim is invalid");
    return ClaimEncryptionPrekeyOutputSchema.parse(JSON.parse(value));
  });
}

function preparedOutput(
  database: Database,
  row: SqliteE2eeBroadcastRow,
  duplicate: boolean,
): PrepareEncryptedBroadcastOutput {
  return PrepareEncryptedBroadcastOutputSchema.parse({
    broadcast_id: row.broadcast_id,
    claims: claimsForBroadcast(database, row.broadcast_id),
    duplicate,
    expires_at: row.expires_at,
    recipient_count: row.recipient_count,
    thread_id: row.thread_id,
  });
}

function existingBroadcast(
  database: Database,
  input: PrepareEncryptedBroadcastInput,
): SqliteE2eeBroadcastRow | null {
  if (input.idempotency_key === undefined) return null;
  const raw: unknown = database
    .query<unknown, [string, string]>(`
      SELECT broadcast_id, committed_at, expires_at, recipient_count, request_json,
        sender_generation, sender_id, state, thread_id
      FROM e2ee_broadcasts WHERE sender_id = ? AND idempotency_key = ?
    `)
    .get(input.sender_id, input.idempotency_key);
  if (raw === null) return null;
  const row: SqliteE2eeBroadcastRow = SqliteE2eeBroadcastRowSchema.parse(raw);
  const storedInput: PrepareEncryptedBroadcastInput = PrepareEncryptedBroadcastInputSchema.parse(
    JSON.parse(row.request_json),
  );
  if (JSON.stringify(storedInput) !== JSON.stringify(input)) {
    throw new IdempotencyConflictError(input.idempotency_key);
  }
  return row;
}

export function prepareSqliteEncryptedBroadcast(
  database: Database,
  inputValue: unknown,
  now: Instant,
): PrepareEncryptedBroadcastOutput {
  const input: PrepareEncryptedBroadcastInput =
    PrepareEncryptedBroadcastInputSchema.parse(inputValue);
  database.exec("BEGIN IMMEDIATE");
  try {
    const prior: SqliteE2eeBroadcastRow | null = existingBroadcast(database, input);
    if (prior !== null) {
      if (prior.state === "cancelled") throw new Error("Encrypted broadcast was cancelled");
      database.exec("COMMIT");
      return preparedOutput(database, prior, true);
    }
    const senderGeneration: number = sqliteE2eeOpenAgentGeneration(database, input.sender_id);
    const recipients: readonly RecipientRow[] = candidateRecipients(database, input, now);
    const broadcastId: string = randomUUID();
    const threadId: string = input.thread_id ?? randomUUID();
    const expiresAt: string = now.addMinutes(PENDING_BROADCAST_MINUTES).toISOString();
    database
      .query<
        unknown,
        [
          string,
          string,
          number,
          string,
          string | null,
          string | null,
          string | null,
          string,
          number,
          string,
          string,
          string,
        ]
      >(`
        INSERT INTO e2ee_broadcasts(
          broadcast_id, sender_id, sender_generation, thread_id,
          audience_repository_name, audience_machine_name, idempotency_key,
          request_json, recipient_count, state, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        broadcastId,
        input.sender_id,
        senderGeneration,
        threadId,
        input.audience.repository ?? null,
        input.audience.machine ?? null,
        input.idempotency_key ?? null,
        JSON.stringify(input),
        recipients.length,
        "pending",
        now.toISOString(),
        expiresAt,
      );
    const claims: ClaimEncryptionPrekeyOutput[] = [];
    for (const recipient of recipients) {
      const claimInput: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse({
        context: input.context,
        recipient_id: recipient.agent_id,
        sender_id: input.sender_id,
      });
      const claim: ClaimEncryptionPrekeyOutput = claimSqliteEncryptionPrekeyInTransaction(
        database,
        claimInput,
        now,
        broadcastId,
      );
      claims.push(claim);
      database
        .query<unknown, [string, string, number, string]>(`
          INSERT INTO e2ee_broadcast_deliveries(
            broadcast_id, recipient_id, recipient_generation, claim_id
          ) VALUES (?, ?, ?, ?)
        `)
        .run(broadcastId, recipient.agent_id, recipient.generation, claim.claim_id);
    }
    updateSqliteE2eeUsage(database, {
      claimCount: 0,
      pendingBroadcastCount: 1,
      pendingCiphertextBytes: 0,
      pendingDeliveryCount: recipients.length,
      publicPrekeyCount: 0,
      retainedCiphertextBytes: 0,
      retainedMessageCount: 0,
    });
    database.exec("COMMIT");
    return PrepareEncryptedBroadcastOutputSchema.parse({
      broadcast_id: broadcastId,
      claims,
      duplicate: false,
      expires_at: expiresAt,
      recipient_count: recipients.length,
      thread_id: threadId,
    });
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function deliveryRow(
  database: Database,
  broadcastId: string,
  claimId: string,
): SqliteE2eeDeliveryRow {
  const raw: unknown = database
    .query<unknown, [string, string]>(`
      SELECT accepted_at, ciphertext_bytes, claim_id, envelope_json,
        recipient_generation, recipient_id, sender_chain_json
      FROM e2ee_broadcast_deliveries WHERE broadcast_id = ? AND claim_id = ?
    `)
    .get(broadcastId, claimId);
  if (raw === null)
    throw new Error("Encrypted broadcast delivery is not in the recipient snapshot");
  return SqliteE2eeDeliveryRowSchema.parse(raw);
}

function storedClaim(database: Database, claimId: string): StoredEncryptionClaim {
  const row: SqliteE2eeClaimRow = SqliteE2eeClaimRowSchema.parse(
    database
      .query<unknown, [string]>(`
        SELECT broadcast_id, claim_json, consumed_at, expires_at,
          recipient_generation, request_json, sender_generation
        FROM e2ee_claims WHERE claim_id = ?
      `)
      .get(claimId),
  );
  return {
    claim: ClaimEncryptionPrekeyOutputSchema.parse(JSON.parse(row.claim_json)),
    recipientGeneration: row.recipient_generation,
    request: ClaimEncryptionPrekeyInputSchema.parse(JSON.parse(row.request_json)),
    senderGeneration: row.sender_generation,
  };
}

function senderChain(
  database: Database,
  claim: StoredEncryptionClaim,
  senderRootKeyId: string,
  senderAgentKeyId: string,
): PublicAgentSigningChainDto {
  if (
    sqliteE2eeOpenAgentGeneration(database, claim.request.sender_id) !== claim.senderGeneration ||
    sqliteE2eeOpenAgentGeneration(database, claim.request.recipient_id) !==
      claim.recipientGeneration
  ) {
    throw new Error("Encryption claim agent generation changed");
  }
  const raw: unknown = database
    .query<unknown, [string, number]>(`
      SELECT bundle_json FROM e2ee_key_bundles
      WHERE agent_id = ? AND agent_generation = ?
    `)
    .get(claim.request.sender_id, claim.senderGeneration);
  if (raw === null || typeof raw !== "object") throw new Error("Sender has no E2E signing bundle");
  const value: unknown = Reflect.get(raw, "bundle_json");
  if (typeof value !== "string") throw new Error("Stored E2E sender bundle is invalid");
  const bundle: PublicAgentKeyBundleDto = PublicAgentKeyBundleDtoSchema.parse(JSON.parse(value));
  if (
    bundle.root_key_id !== senderRootKeyId ||
    bundle.agent_certificate.signing_key_id !== senderAgentKeyId
  ) {
    throw new Error("Encrypted envelope sender does not match its published signing bundle");
  }
  return senderChainFromBundle(bundle);
}

export function putSqliteEncryptedBroadcastDelivery(
  database: Database,
  tenantId: string,
  inputValue: unknown,
  now: Instant,
): PutEncryptedBroadcastDeliveryOutput {
  const input: PutEncryptedBroadcastDeliveryInput =
    PutEncryptedBroadcastDeliveryInputSchema.parse(inputValue);
  const envelopeJson: string = e2eeEnvelopeJson(input.envelope);
  database.exec("BEGIN IMMEDIATE");
  try {
    const broadcast: SqliteE2eeBroadcastRow = readSqliteE2eeBroadcast(database, input.broadcast_id);
    const delivery: SqliteE2eeDeliveryRow = deliveryRow(
      database,
      input.broadcast_id,
      input.claim_id,
    );
    if (broadcast.state === "committed") {
      if (delivery.envelope_json !== envelopeJson) {
        throw new IdempotencyConflictError(input.envelope.header.idempotency_key);
      }
      database.exec("COMMIT");
      return PutEncryptedBroadcastDeliveryOutputSchema.parse({
        accepted: true,
        duplicate: true,
        recipient_id: delivery.recipient_id,
      });
    }
    if (broadcast.state !== "pending" || broadcast.expires_at <= now.toISOString()) {
      throw new Error("Encrypted broadcast is unavailable or expired");
    }
    if (delivery.envelope_json !== null) {
      if (delivery.envelope_json !== envelopeJson) {
        throw new IdempotencyConflictError(input.envelope.header.idempotency_key);
      }
      database.exec("COMMIT");
      return PutEncryptedBroadcastDeliveryOutputSchema.parse({
        accepted: true,
        duplicate: true,
        recipient_id: delivery.recipient_id,
      });
    }
    const claim: StoredEncryptionClaim = storedClaim(database, input.claim_id);
    validateEnvelopeForClaim(
      input.envelope,
      claim,
      tenantId,
      input.broadcast_id,
      now.toISOString(),
    );
    if (input.envelope.header.thread_id !== broadcast.thread_id) {
      throw new Error("Encrypted broadcast delivery thread does not match its snapshot");
    }
    const chain: PublicAgentSigningChainDto = senderChain(
      database,
      claim,
      input.envelope.header.sender_root_key_id,
      input.envelope.header.sender_agent_key_id,
    );
    const ciphertextBytes: number = encryptedCiphertextBytes(input.envelope);
    database
      .query<unknown, [string, string, number, string, string, string]>(`
        UPDATE e2ee_broadcast_deliveries SET
          envelope_json = ?, sender_chain_json = ?, ciphertext_bytes = ?, accepted_at = ?
        WHERE broadcast_id = ? AND claim_id = ? AND envelope_json IS NULL
      `)
      .run(
        envelopeJson,
        JSON.stringify(chain),
        ciphertextBytes,
        now.toISOString(),
        input.broadcast_id,
        input.claim_id,
      );
    database
      .query<unknown, [string, string]>(`
        UPDATE e2ee_claims SET consumed_at = ? WHERE claim_id = ? AND consumed_at IS NULL
      `)
      .run(now.toISOString(), input.claim_id);
    updateSqliteE2eeUsage(database, {
      claimCount: 0,
      pendingBroadcastCount: 0,
      pendingCiphertextBytes: ciphertextBytes,
      pendingDeliveryCount: 0,
      publicPrekeyCount: 0,
      retainedCiphertextBytes: 0,
      retainedMessageCount: 0,
    });
    database.exec("COMMIT");
    return PutEncryptedBroadcastDeliveryOutputSchema.parse({
      accepted: true,
      duplicate: false,
      recipient_id: delivery.recipient_id,
    });
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
