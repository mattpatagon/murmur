import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type { Agent } from "../domain/models.js";
import { AgentId, type Instant, type TenantId } from "../domain/value-objects.js";
import {
  type CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastInputSchema,
  type CancelEncryptedBroadcastOutput,
  CancelEncryptedBroadcastOutputSchema,
  type CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastInputSchema,
  type CommitEncryptedBroadcastOutput,
  CommitEncryptedBroadcastOutputSchema,
} from "../e2ee/wire-tools.js";
import { reserveTemporaryMaterializationBytes } from "../materialization-budget.js";
import {
  assertE2eeDeliveryBatch,
  E2EE_BROADCAST_COMMIT_BATCH_SIZE,
  E2EE_BROADCAST_COMMIT_SNAPSHOT_LIMIT,
  type E2eeDeliverySnapshot,
  e2eeDeliveryBatches,
  maximumE2eeCommitBatchBytes,
  parseE2eeDeliverySnapshot,
  validatedE2eeBroadcastDelivery,
} from "./e2ee-broadcast-commit-batches.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
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
import { allocatePostgresE2eeSequences } from "./postgres-e2ee-sequence.js";
import { requirePostgresE2eeWriteState } from "./postgres-e2ee-state.js";
import { updatePostgresE2eeUsage } from "./postgres-e2ee-usage.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

async function deliverySnapshot(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcast: PostgresE2eeBroadcastRow,
): Promise<readonly E2eeDeliverySnapshot[]> {
  const raw: unknown = await transaction`
    SELECT
      CASE WHEN accepted_at IS NULL THEN NULL ELSE
        to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS accepted_at,
      ciphertext_bytes, claim_id::text AS claim_id,
      octet_length(envelope_json::text) AS envelope_bytes,
      recipient_generation, recipient_id,
      octet_length(sender_chain_json::text) AS sender_chain_bytes
    FROM murmur.e2ee_broadcast_deliveries
    WHERE tenant_id = ${tenantId.value}::uuid AND broadcast_id = ${broadcast.broadcast_id}::uuid
    ORDER BY recipient_id ASC LIMIT ${E2EE_BROADCAST_COMMIT_SNAPSHOT_LIMIT}
    FOR UPDATE
  `;
  return parseE2eeDeliverySnapshot(raw, broadcast.recipient_count);
}

async function deliveryBatch(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcastId: string,
  snapshot: readonly E2eeDeliverySnapshot[],
): Promise<readonly PostgresE2eeDeliveryRow[]> {
  const claims: string[] = snapshot.map((row: E2eeDeliverySnapshot): string => row.claim_id);
  const raw: unknown = await transaction`
    SELECT
      CASE WHEN accepted_at IS NULL THEN NULL ELSE
        to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS accepted_at,
      ciphertext_bytes, claim_id::text AS claim_id, envelope_json::text AS envelope_json,
      recipient_generation, recipient_id, sender_chain_json::text AS sender_chain_json
    FROM murmur.e2ee_broadcast_deliveries
    WHERE tenant_id = ${tenantId.value}::uuid AND broadcast_id = ${broadcastId}::uuid
      AND claim_id = ANY(${transaction.array(claims)}::uuid[])
    ORDER BY recipient_id ASC LIMIT ${E2EE_BROADCAST_COMMIT_BATCH_SIZE}
  `;
  const rows: PostgresE2eeDeliveryRow[] = z
    .array(PostgresE2eeDeliveryRowSchema)
    .max(E2EE_BROADCAST_COMMIT_BATCH_SIZE)
    .parse(raw);
  assertE2eeDeliveryBatch(rows, snapshot);
  return rows;
}

function committedOutput(
  row: PostgresE2eeBroadcastRow,
  duplicate: boolean,
): CommitEncryptedBroadcastOutput {
  if (row.committed_at === null) throw new Error("Encrypted broadcast commit time is missing");
  return CommitEncryptedBroadcastOutputSchema.parse({
    broadcast_id: row.broadcast_id,
    committed_at: row.committed_at,
    duplicate,
    recipient_count: row.recipient_count,
    status: "stored",
  });
}

async function requireCurrentGenerations(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcast: PostgresE2eeBroadcastRow,
  deliveries: readonly E2eeDeliverySnapshot[],
  now: Instant,
): Promise<void> {
  const sender: Agent = await postgresAgentInTransaction(
    transaction,
    tenantId,
    AgentId.parse(broadcast.sender_id),
    now,
  );
  if (sender.state === "closed" || sender.generation.value !== broadcast.sender_generation) {
    throw new Error("Encrypted broadcast sender generation changed");
  }
  for (const delivery of deliveries) {
    const recipient: Agent = await postgresAgentInTransaction(
      transaction,
      tenantId,
      AgentId.parse(delivery.recipient_id),
      now,
    );
    if (
      recipient.state === "closed" ||
      recipient.generation.value !== delivery.recipient_generation
    ) {
      throw new Error("Encrypted broadcast recipient generation changed");
    }
  }
}

async function insertDeliveries(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcast: PostgresE2eeBroadcastRow,
  snapshot: readonly E2eeDeliverySnapshot[],
): Promise<number> {
  if (snapshot.length === 0) return 0;
  const release: () => void = reserveTemporaryMaterializationBytes(
    maximumE2eeCommitBatchBytes(snapshot),
  );
  try {
    const firstSequence: number = await allocatePostgresE2eeSequences(
      transaction,
      tenantId,
      snapshot.length,
    );
    let ciphertextBytes: number = 0;
    let index: number = 0;
    for (const batch of e2eeDeliveryBatches(snapshot)) {
      const deliveries: readonly PostgresE2eeDeliveryRow[] = await deliveryBatch(
        transaction,
        tenantId,
        broadcast.broadcast_id,
        batch,
      );
      for (const delivery of deliveries) {
        const { envelope, senderChain }: ReturnType<typeof validatedE2eeBroadcastDelivery> =
          validatedE2eeBroadcastDelivery(delivery, broadcast);
        if (delivery.ciphertext_bytes === null)
          throw new Error("Encrypted broadcast delivery set is incomplete");
        ciphertextBytes += delivery.ciphertext_bytes;
        await transaction`
      INSERT INTO murmur.e2ee_messages(
        tenant_id, tenant_sequence, message_id, thread_id,
        sender_id, sender_generation, sender_authority, message_kind,
        orchestrator_policy_id, recipient_id, recipient_generation, broadcast_id,
        idempotency_key, pair_counter, envelope_json, sender_chain_json,
        ciphertext_bytes, created_at, expires_at
      ) VALUES (
        ${tenantId.value}::uuid, ${firstSequence + index}, ${envelope.header.message_id}::uuid,
        ${envelope.header.thread_id}, ${envelope.header.sender_id},
        ${broadcast.sender_generation}, ${envelope.header.sender_authority},
        ${envelope.header.message_kind}, ${envelope.header.orchestrator_policy_id}::uuid,
        ${delivery.recipient_id}, ${delivery.recipient_generation},
        ${broadcast.broadcast_id}::uuid, ${envelope.header.idempotency_key},
        ${envelope.header.pair_counter}, ${transaction.json(envelope)},
        ${transaction.json(senderChain)}, ${delivery.ciphertext_bytes},
        ${envelope.header.created_at}::timestamptz, ${envelope.header.expires_at}::timestamptz
      )
    `;
        index += 1;
      }
    }
    return ciphertextBytes;
  } finally {
    release();
  }
}

export async function commitPostgresEncryptedBroadcast(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  authorization: E2eeWriteAuthorization,
  now: Instant,
): Promise<CommitEncryptedBroadcastOutput> {
  const input: CommitEncryptedBroadcastInput =
    CommitEncryptedBroadcastInputSchema.parse(inputValue);
  return await database.begin(
    async (transaction: TransactionSql): Promise<CommitEncryptedBroadcastOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requirePostgresE2eeWriteState(transaction, tenantId, ["enforced"]);
      const broadcast: PostgresE2eeBroadcastRow = await readPostgresE2eeBroadcast(
        transaction,
        tenantId,
        input.broadcast_id,
      );
      assertPostgresE2eeBroadcastAuthorization(broadcast, authorization);
      if (broadcast.state === "committed") return committedOutput(broadcast, true);
      if (broadcast.state !== "pending" || broadcast.expires_at <= now.toISOString()) {
        throw new Error("Encrypted broadcast is unavailable or expired");
      }
      const deliveries: readonly E2eeDeliverySnapshot[] = await deliverySnapshot(
        transaction,
        tenantId,
        broadcast,
      );
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        broadcast.sender_id,
        ...deliveries.map((delivery: E2eeDeliverySnapshot): string => delivery.recipient_id),
      ]);
      await requireCurrentGenerations(transaction, tenantId, broadcast, deliveries, now);
      const ciphertextBytes: number = await insertDeliveries(
        transaction,
        tenantId,
        broadcast,
        deliveries,
      );
      const committedAt: string = now.toISOString();
      const rawCommitted: unknown = await transaction`
        UPDATE murmur.e2ee_broadcasts
        SET state = 'committed', committed_at = ${committedAt}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid
          AND broadcast_id = ${input.broadcast_id}::uuid AND state = 'pending'
        RETURNING broadcast_id::text AS broadcast_id
      `;
      const committed: { readonly broadcast_id: string }[] = z
        .array(z.strictObject({ broadcast_id: z.string().uuid() }))
        .parse(rawCommitted);
      if (committed.length !== 1) throw new Error("Encrypted broadcast was concurrently finalized");
      await updatePostgresE2eeUsage(transaction, tenantId, {
        claimCount: -deliveries.length,
        pendingBroadcastCount: -1,
        pendingCiphertextBytes: -ciphertextBytes,
        pendingDeliveryCount: -deliveries.length,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: ciphertextBytes,
        retainedMessageCount: deliveries.length,
      });
      return committedOutput(
        { ...broadcast, committed_at: committedAt, state: "committed" },
        false,
      );
    },
  );
}

async function pendingCiphertextBytes(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcastId: string,
): Promise<number> {
  const raw: unknown = await transaction`
    SELECT COALESCE(SUM(ciphertext_bytes), 0)::bigint AS count
    FROM murmur.e2ee_broadcast_deliveries
    WHERE tenant_id = ${tenantId.value}::uuid AND broadcast_id = ${broadcastId}::uuid
  `;
  const rows: { readonly count: number }[] = z
    .array(
      z.strictObject({
        count: z
          .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
          .transform((value: bigint | number | string): number => Number(value)),
      }),
    )
    .parse(raw);
  const row: { readonly count: number } | undefined = rows[0];
  if (row === undefined) throw new Error("Encrypted broadcast usage is unavailable");
  return row.count;
}

export async function cancelPostgresEncryptedBroadcast(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  authorization: E2eeWriteAuthorization,
): Promise<CancelEncryptedBroadcastOutput> {
  const input: CancelEncryptedBroadcastInput =
    CancelEncryptedBroadcastInputSchema.parse(inputValue);
  return await database.begin(
    async (transaction: TransactionSql): Promise<CancelEncryptedBroadcastOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requirePostgresE2eeWriteState(transaction, tenantId, ["enforced"]);
      const broadcast: PostgresE2eeBroadcastRow = await readPostgresE2eeBroadcast(
        transaction,
        tenantId,
        input.broadcast_id,
      );
      assertPostgresE2eeBroadcastAuthorization(broadcast, authorization);
      if (broadcast.state === "committed") {
        return CancelEncryptedBroadcastOutputSchema.parse({ cancelled: false });
      }
      if (broadcast.state === "cancelled") {
        return CancelEncryptedBroadcastOutputSchema.parse({ cancelled: true });
      }
      const ciphertextBytes: number = await pendingCiphertextBytes(
        transaction,
        tenantId,
        input.broadcast_id,
      );
      await transaction`
        UPDATE murmur.e2ee_broadcasts SET state = 'cancelled'
        WHERE tenant_id = ${tenantId.value}::uuid
          AND broadcast_id = ${input.broadcast_id}::uuid AND state = 'pending'
      `;
      await updatePostgresE2eeUsage(transaction, tenantId, {
        claimCount: -broadcast.recipient_count,
        pendingBroadcastCount: -1,
        pendingCiphertextBytes: -ciphertextBytes,
        pendingDeliveryCount: -broadcast.recipient_count,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: 0,
        retainedMessageCount: 0,
      });
      return CancelEncryptedBroadcastOutputSchema.parse({ cancelled: true });
    },
  );
}
