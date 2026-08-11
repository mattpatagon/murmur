import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { IdempotencyConflictError } from "../domain/errors.js";
import type { Agent } from "../domain/models.js";
import { AgentId, type Instant, type TenantId } from "../domain/value-objects.js";
import { verifyHostedEncryptedEnvelope } from "../e2ee/hosted-validation.js";
import { MAX_E2EE_CIPHERTEXT_BYTES } from "../e2ee/wire-contracts.js";
import {
  type EncryptedMessageDto,
  EncryptedMessageDtoSchema,
  type PutEncryptedMessageInput,
  PutEncryptedMessageInputSchema,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
} from "../e2ee/wire-tools.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
import {
  e2eeEnvelopeJson,
  encryptedCiphertextBytes,
  type StoredEncryptionClaim,
  validateEnvelopeForClaim,
} from "./e2ee-store-validation.js";
import { postgresAgentInTransaction } from "./postgres-agent-lifecycle-store.js";
import { requireEffectivePostgresOrchestratorClaim } from "./postgres-e2ee-keys.js";
import { type PostgresE2eeMessageRow, PostgresE2eeMessageRowSchema } from "./postgres-e2ee-rows.js";
import { allocatePostgresE2eeSequences } from "./postgres-e2ee-sequence.js";
import { requirePostgresE2eeWriteState } from "./postgres-e2ee-state.js";
import { updatePostgresE2eeUsage } from "./postgres-e2ee-usage.js";
import {
  type PostgresHostedEnvelopeValidationContext,
  postgresHostedEnvelopeValidationContext,
} from "./postgres-e2ee-validation-context.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

export function postgresEncryptedMessageFromRow(row: PostgresE2eeMessageRow): EncryptedMessageDto {
  return EncryptedMessageDtoSchema.parse({
    envelope: JSON.parse(row.envelope_json),
    read_at: row.read_at,
    sender_chain: JSON.parse(row.sender_chain_json),
    tenant_sequence: row.tenant_sequence,
  });
}

function putOutput(row: PostgresE2eeMessageRow, duplicate: boolean): PutEncryptedMessageOutput {
  return PutEncryptedMessageOutputSchema.parse({
    duplicate,
    message: postgresEncryptedMessageFromRow(row),
    retention_days: RETENTION_DAYS,
    status: "stored",
  });
}

async function existingMessage(
  transaction: TransactionSql,
  tenantId: TenantId,
  senderId: string,
  idempotencyKey: string,
): Promise<PostgresE2eeMessageRow | null> {
  const raw: unknown = await transaction`
    SELECT tenant_sequence, envelope_json::text AS envelope_json,
      sender_chain_json::text AS sender_chain_json,
      CASE WHEN read_at IS NULL THEN NULL ELSE
        to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS read_at
    FROM murmur.e2ee_messages
    WHERE tenant_id = ${tenantId.value}::uuid
      AND sender_id = ${senderId} AND idempotency_key = ${idempotencyKey}
  `;
  const rows: PostgresE2eeMessageRow[] = z.array(PostgresE2eeMessageRowSchema).parse(raw);
  return rows[0] ?? null;
}

function storedClaim(validation: PostgresHostedEnvelopeValidationContext): StoredEncryptionClaim {
  return {
    claim: validation.claimOutput,
    recipientGeneration: validation.row.recipient_generation,
    request: validation.claimInput,
    senderGeneration: validation.row.sender_generation,
  };
}

async function requireCurrentClaimAgents(
  transaction: TransactionSql,
  tenantId: TenantId,
  validation: PostgresHostedEnvelopeValidationContext,
  now: Instant,
): Promise<void> {
  const sender: Agent = await postgresAgentInTransaction(
    transaction,
    tenantId,
    AgentId.parse(validation.claimInput.sender_id),
    now,
  );
  const recipient: Agent = await postgresAgentInTransaction(
    transaction,
    tenantId,
    AgentId.parse(validation.claimInput.recipient_id),
    now,
  );
  if (
    sender.state === "closed" ||
    recipient.state === "closed" ||
    sender.generation.value !== validation.row.sender_generation ||
    recipient.generation.value !== validation.row.recipient_generation
  ) {
    throw new Error("Encryption claim agent generation changed");
  }
}

export async function putPostgresEncryptedMessage(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  authorization: E2eeWriteAuthorization,
  now: Instant,
): Promise<PutEncryptedMessageOutput> {
  const input: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse(inputValue);
  const envelopeJson: string = e2eeEnvelopeJson(input.envelope);
  const header: PutEncryptedMessageInput["envelope"]["header"] = input.envelope.header;
  return await database.begin(
    async (transaction: TransactionSql): Promise<PutEncryptedMessageOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requirePostgresE2eeWriteState(transaction, tenantId, ["enforced"]);
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        header.recipient_id,
        header.sender_id,
      ]);
      const prior: PostgresE2eeMessageRow | null = await existingMessage(
        transaction,
        tenantId,
        header.sender_id,
        header.idempotency_key,
      );
      if (prior !== null) {
        if (e2eeEnvelopeJson(JSON.parse(prior.envelope_json)) !== envelopeJson) {
          throw new IdempotencyConflictError(header.idempotency_key);
        }
        return putOutput(prior, true);
      }
      const validation: PostgresHostedEnvelopeValidationContext =
        await postgresHostedEnvelopeValidationContext(transaction, tenantId, input.claim_id);
      if (
        validation.row.broadcast_id !== null ||
        validation.row.consumed_at !== null ||
        validation.row.expires_at <= now.toISOString()
      ) {
        throw new Error("Encryption claim is unavailable or expired");
      }
      if (validation.claimOutput.provenance.message_kind === "orchestration_request") {
        if (
          authorization.boundSenderId !== null &&
          authorization.boundSenderId !== validation.claimInput.sender_id
        ) {
          throw new Error("Encrypted sender authority is unavailable for this credential");
        }
        await requireEffectivePostgresOrchestratorClaim(
          transaction,
          tenantId,
          validation.claimInput,
          authorization,
          validation.claimOutput.provenance.orchestrator_policy_id,
          validation.row.orchestrator_token_id,
        );
      }
      await requireCurrentClaimAgents(transaction, tenantId, validation, now);
      const claim: StoredEncryptionClaim = storedClaim(validation);
      validateEnvelopeForClaim(input.envelope, claim, tenantId.value, null, now.toISOString());
      await verifyHostedEncryptedEnvelope({
        claimInput: validation.claimInput,
        claimOutput: validation.claimOutput,
        expectedBroadcastId: null,
        maxCiphertextBytes: MAX_E2EE_CIPHERTEXT_BYTES,
        now: new Date(now.toISOString()),
        putInput: input,
        senderChain: validation.senderChain,
        tenantId: tenantId.value,
      });
      const ciphertextBytes: number = encryptedCiphertextBytes(input.envelope);
      const tenantSequence: number = await allocatePostgresE2eeSequences(transaction, tenantId, 1);
      const rawInserted: unknown = await transaction`
        INSERT INTO murmur.e2ee_messages(
          tenant_id, tenant_sequence, message_id, thread_id,
          sender_id, sender_generation, sender_authority, message_kind,
          orchestrator_policy_id, recipient_id, recipient_generation, broadcast_id,
          idempotency_key, pair_counter, envelope_json, sender_chain_json,
          ciphertext_bytes, created_at, expires_at
        ) VALUES (
          ${tenantId.value}::uuid, ${tenantSequence}, ${header.message_id}::uuid,
          ${header.thread_id}, ${header.sender_id}, ${validation.row.sender_generation},
          ${validation.claimOutput.provenance.sender_authority},
          ${validation.claimOutput.provenance.message_kind},
          ${validation.claimOutput.provenance.orchestrator_policy_id}::uuid,
          ${header.recipient_id}, ${validation.row.recipient_generation}, NULL,
          ${header.idempotency_key}, ${header.pair_counter}, ${database.json(input.envelope)},
          ${database.json(validation.senderChain)}, ${ciphertextBytes},
          ${header.created_at}::timestamptz, ${header.expires_at}::timestamptz
        )
        RETURNING tenant_sequence, envelope_json::text AS envelope_json,
          sender_chain_json::text AS sender_chain_json, NULL::text AS read_at
      `;
      const insertedRows: PostgresE2eeMessageRow[] = z
        .array(PostgresE2eeMessageRowSchema)
        .parse(rawInserted);
      const inserted: PostgresE2eeMessageRow | undefined = insertedRows[0];
      if (inserted === undefined)
        throw new Error("Stored encrypted message acknowledgement is missing");
      const consumedRaw: unknown = await transaction`
        UPDATE murmur.e2ee_claims
        SET consumed_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid AND claim_id = ${input.claim_id}::uuid
          AND consumed_at IS NULL
        RETURNING claim_id::text AS claim_id
      `;
      const consumed: { readonly claim_id: string }[] = z
        .array(z.strictObject({ claim_id: z.string().uuid() }))
        .parse(consumedRaw);
      if (consumed.length !== 1) throw new Error("Encryption claim was concurrently consumed");
      await updatePostgresE2eeUsage(transaction, tenantId, {
        claimCount: -1,
        pendingBroadcastCount: 0,
        pendingCiphertextBytes: 0,
        pendingDeliveryCount: 0,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: ciphertextBytes,
        retainedMessageCount: 1,
      });
      return putOutput(inserted, false);
    },
  );
}
