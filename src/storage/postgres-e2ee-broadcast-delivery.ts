import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { IdempotencyConflictError } from "../domain/errors.js";
import type { Agent } from "../domain/models.js";
import { AgentId, type Instant, type TenantId } from "../domain/value-objects.js";
import { verifyHostedEncryptedEnvelope } from "../e2ee/hosted-validation.js";
import { MAX_E2EE_CIPHERTEXT_BYTES } from "../e2ee/wire-contracts.js";
import {
  type PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryInputSchema,
  type PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedBroadcastDeliveryOutputSchema,
} from "../e2ee/wire-tools.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
import {
  e2eeEnvelopeJson,
  encryptedCiphertextBytes,
  type StoredEncryptionClaim,
  validateEnvelopeForClaim,
} from "./e2ee-store-validation.js";
import { postgresAgentInTransaction } from "./postgres-agent-lifecycle-store.js";
import {
  assertPostgresE2eeBroadcastAuthorization,
  readPostgresE2eeBroadcast,
} from "./postgres-e2ee-broadcast-state.js";
import {
  type PostgresE2eeBroadcastRow,
  type PostgresE2eeDeliveryRow,
  PostgresE2eeDeliveryRowSchema,
} from "./postgres-e2ee-rows.js";
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

async function deliveryRow(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcastId: string,
  claimId: string,
): Promise<PostgresE2eeDeliveryRow> {
  const raw: unknown = await transaction`
    SELECT
      CASE WHEN accepted_at IS NULL THEN NULL ELSE
        to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS accepted_at,
      ciphertext_bytes, claim_id::text AS claim_id, envelope_json::text AS envelope_json,
      recipient_generation, recipient_id, sender_chain_json::text AS sender_chain_json
    FROM murmur.e2ee_broadcast_deliveries
    WHERE tenant_id = ${tenantId.value}::uuid
      AND broadcast_id = ${broadcastId}::uuid AND claim_id = ${claimId}::uuid
    FOR UPDATE
  `;
  const rows: PostgresE2eeDeliveryRow[] = z.array(PostgresE2eeDeliveryRowSchema).parse(raw);
  const row: PostgresE2eeDeliveryRow | undefined = rows[0];
  if (row === undefined) {
    throw new Error("Encrypted broadcast delivery is not in the recipient snapshot");
  }
  return row;
}

function duplicateOutput(delivery: PostgresE2eeDeliveryRow): PutEncryptedBroadcastDeliveryOutput {
  return PutEncryptedBroadcastDeliveryOutputSchema.parse({
    accepted: true,
    duplicate: true,
    recipient_id: delivery.recipient_id,
  });
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

export async function putPostgresEncryptedBroadcastDelivery(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  authorization: E2eeWriteAuthorization,
  now: Instant,
): Promise<PutEncryptedBroadcastDeliveryOutput> {
  const input: PutEncryptedBroadcastDeliveryInput =
    PutEncryptedBroadcastDeliveryInputSchema.parse(inputValue);
  const envelopeJson: string = e2eeEnvelopeJson(input.envelope);
  return await database.begin(
    async (transaction: TransactionSql): Promise<PutEncryptedBroadcastDeliveryOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requirePostgresE2eeWriteState(transaction, tenantId, ["enforced"]);
      const broadcast: PostgresE2eeBroadcastRow = await readPostgresE2eeBroadcast(
        transaction,
        tenantId,
        input.broadcast_id,
      );
      assertPostgresE2eeBroadcastAuthorization(broadcast, authorization);
      const delivery: PostgresE2eeDeliveryRow = await deliveryRow(
        transaction,
        tenantId,
        input.broadcast_id,
        input.claim_id,
      );
      if (broadcast.state === "committed" || delivery.envelope_json !== null) {
        if (
          delivery.envelope_json === null ||
          e2eeEnvelopeJson(JSON.parse(delivery.envelope_json)) !== envelopeJson
        ) {
          throw new IdempotencyConflictError(input.envelope.header.idempotency_key);
        }
        return duplicateOutput(delivery);
      }
      if (broadcast.state !== "pending" || broadcast.expires_at <= now.toISOString()) {
        throw new Error("Encrypted broadcast is unavailable or expired");
      }
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        input.envelope.header.recipient_id,
        input.envelope.header.sender_id,
      ]);
      const validation: PostgresHostedEnvelopeValidationContext =
        await postgresHostedEnvelopeValidationContext(transaction, tenantId, input.claim_id);
      if (
        validation.row.broadcast_id !== input.broadcast_id ||
        validation.row.consumed_at !== null ||
        validation.row.expires_at <= now.toISOString()
      ) {
        throw new Error("Encryption claim is unavailable or expired");
      }
      await requireCurrentClaimAgents(transaction, tenantId, validation, now);
      const claim: StoredEncryptionClaim = {
        claim: validation.claimOutput,
        recipientGeneration: validation.row.recipient_generation,
        request: validation.claimInput,
        senderGeneration: validation.row.sender_generation,
      };
      validateEnvelopeForClaim(
        input.envelope,
        claim,
        tenantId.value,
        input.broadcast_id,
        now.toISOString(),
      );
      if (input.envelope.header.thread_id !== broadcast.thread_id) {
        throw new Error("Encrypted broadcast delivery thread does not match its snapshot");
      }
      await verifyHostedEncryptedEnvelope({
        claimInput: validation.claimInput,
        claimOutput: validation.claimOutput,
        expectedBroadcastId: input.broadcast_id,
        maxCiphertextBytes: MAX_E2EE_CIPHERTEXT_BYTES,
        now: new Date(now.toISOString()),
        putInput: { claim_id: input.claim_id, envelope: input.envelope },
        senderChain: validation.senderChain,
        tenantId: tenantId.value,
      });
      const ciphertextBytes: number = encryptedCiphertextBytes(input.envelope);
      const rawAccepted: unknown = await transaction`
        UPDATE murmur.e2ee_broadcast_deliveries SET
          envelope_json = ${database.json(input.envelope)},
          sender_chain_json = ${database.json(validation.senderChain)},
          ciphertext_bytes = ${ciphertextBytes},
          accepted_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid
          AND broadcast_id = ${input.broadcast_id}::uuid
          AND claim_id = ${input.claim_id}::uuid AND envelope_json IS NULL
        RETURNING recipient_id
      `;
      const accepted: { readonly recipient_id: string }[] = z
        .array(z.strictObject({ recipient_id: z.string() }))
        .parse(rawAccepted);
      if (accepted.length !== 1) throw new Error("Encrypted delivery was concurrently accepted");
      const rawConsumed: unknown = await transaction`
        UPDATE murmur.e2ee_claims SET consumed_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid AND claim_id = ${input.claim_id}::uuid
          AND consumed_at IS NULL
        RETURNING claim_id::text AS claim_id
      `;
      const consumed: { readonly claim_id: string }[] = z
        .array(z.strictObject({ claim_id: z.string().uuid() }))
        .parse(rawConsumed);
      if (consumed.length !== 1) throw new Error("Encryption claim was concurrently consumed");
      await updatePostgresE2eeUsage(transaction, tenantId, {
        claimCount: 0,
        pendingBroadcastCount: 0,
        pendingCiphertextBytes: ciphertextBytes,
        pendingDeliveryCount: 0,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: 0,
        retainedMessageCount: 0,
      });
      return PutEncryptedBroadcastDeliveryOutputSchema.parse({
        accepted: true,
        duplicate: false,
        recipient_id: delivery.recipient_id,
      });
    },
  );
}
