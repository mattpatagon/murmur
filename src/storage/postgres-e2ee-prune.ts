import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type { Instant, TenantId } from "../domain/value-objects.js";
import { updatePostgresE2eeUsage } from "./postgres-e2ee-usage.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

type UsageCounts = {
  readonly ciphertext_bytes: number;
  readonly item_count: number;
  readonly recipient_count: number;
};

const DatabaseIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)), {
    message: "Postgres integer exceeds JavaScript's safe integer range",
  })
  .transform((value: bigint | number | string): number => Number(value));
const UsageCountsSchema: z.ZodType<UsageCounts> = z.strictObject({
  ciphertext_bytes: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
  item_count: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
  recipient_count: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

async function expiredBroadcastUsage(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<UsageCounts> {
  await transaction`
    SELECT broadcast_id
    FROM murmur.e2ee_broadcasts
    WHERE tenant_id = ${tenantId.value}::uuid AND state = 'pending'
      AND expires_at <= ${now.toISOString()}::timestamptz
    ORDER BY broadcast_id
    FOR UPDATE
  `;
  const raw: unknown = await transaction`
    WITH expired AS (
      SELECT broadcast.broadcast_id, broadcast.recipient_count,
        COALESCE(SUM(delivery.ciphertext_bytes), 0)::bigint AS ciphertext_bytes
      FROM murmur.e2ee_broadcasts AS broadcast
      LEFT JOIN murmur.e2ee_broadcast_deliveries AS delivery
        ON delivery.tenant_id = broadcast.tenant_id
        AND delivery.broadcast_id = broadcast.broadcast_id
      WHERE broadcast.tenant_id = ${tenantId.value}::uuid
        AND broadcast.state = 'pending'
        AND broadcast.expires_at <= ${now.toISOString()}::timestamptz
      GROUP BY broadcast.broadcast_id, broadcast.recipient_count
    )
    SELECT COALESCE(SUM(ciphertext_bytes), 0)::bigint AS ciphertext_bytes,
      COUNT(*)::bigint AS item_count,
      COALESCE(SUM(recipient_count), 0)::bigint AS recipient_count
    FROM expired
  `;
  const rows: UsageCounts[] = z.array(UsageCountsSchema).parse(raw);
  const row: UsageCounts | undefined = rows[0];
  if (row === undefined) throw new Error("Expired encrypted broadcast usage is unavailable");
  return row;
}

async function expiredMessageUsage(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<UsageCounts> {
  const raw: unknown = await transaction`
    WITH expired AS (
      SELECT tenant_id, message_id, ciphertext_bytes
      FROM murmur.e2ee_messages
      WHERE tenant_id = ${tenantId.value}::uuid
        AND expires_at <= ${now.toISOString()}::timestamptz
      ORDER BY tenant_sequence ASC
      LIMIT 1000
      FOR UPDATE
    ), deleted AS (
      DELETE FROM murmur.e2ee_messages AS message USING expired
      WHERE message.tenant_id = expired.tenant_id AND message.message_id = expired.message_id
      RETURNING expired.ciphertext_bytes
    )
    SELECT COALESCE(SUM(ciphertext_bytes), 0)::bigint AS ciphertext_bytes,
      COUNT(*)::bigint AS item_count, 0::bigint AS recipient_count
    FROM deleted
  `;
  const rows: UsageCounts[] = z.array(UsageCountsSchema).parse(raw);
  const row: UsageCounts | undefined = rows[0];
  if (row === undefined) throw new Error("Expired encrypted message usage is unavailable");
  return row;
}

async function expireDirectClaims(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  const raw: unknown = await transaction`
    UPDATE murmur.e2ee_claims
    SET consumed_at = ${now.toISOString()}::timestamptz
    WHERE tenant_id = ${tenantId.value}::uuid
      AND broadcast_id IS NULL AND consumed_at IS NULL
      AND expires_at <= ${now.toISOString()}::timestamptz
    RETURNING claim_id::text AS claim_id
  `;
  return z.array(z.strictObject({ claim_id: z.string().uuid() })).parse(raw).length;
}

async function expirePublicPrekeys(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  const raw: unknown = await transaction`
    UPDATE murmur.e2ee_prekeys
    SET retired_at = ${now.toISOString()}::timestamptz
    WHERE tenant_id = ${tenantId.value}::uuid
      AND retired_at IS NULL AND claimed_at IS NULL
      AND expires_at <= ${now.toISOString()}::timestamptz
    RETURNING prekey_id
  `;
  return z.array(z.strictObject({ prekey_id: z.string() })).parse(raw).length;
}

async function cleanupExpiredRows(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<void> {
  await transaction`
    DELETE FROM murmur.e2ee_claims
    WHERE tenant_id = ${tenantId.value}::uuid
      AND broadcast_id IS NULL AND expires_at <= ${now.toISOString()}::timestamptz
  `;
  await transaction`
    DELETE FROM murmur.e2ee_broadcasts AS broadcast
    WHERE broadcast.tenant_id = ${tenantId.value}::uuid
      AND broadcast.state IN ('cancelled', 'committed')
      AND broadcast.expires_at <= ${now.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM murmur.e2ee_messages AS message
        WHERE message.tenant_id = broadcast.tenant_id
          AND message.broadcast_id = broadcast.broadcast_id
      )
  `;
  await transaction`
    DELETE FROM murmur.e2ee_prekeys AS prekey
    WHERE prekey.tenant_id = ${tenantId.value}::uuid
      AND (prekey.retired_at IS NOT NULL OR prekey.claimed_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM murmur.e2ee_claims AS claim
        WHERE claim.tenant_id = prekey.tenant_id AND claim.prekey_id = prekey.prekey_id
      )
  `;
}

export async function prunePostgresE2ee(
  database: Sql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  return await database.begin(async (transaction: TransactionSql): Promise<number> => {
    await setPostgresTenantContext(transaction, tenantId);
    const broadcasts: UsageCounts = await expiredBroadcastUsage(transaction, tenantId, now);
    const directClaims: number = await expireDirectClaims(transaction, tenantId, now);
    const expiredPrekeys: number = await expirePublicPrekeys(transaction, tenantId, now);
    await transaction`
      UPDATE murmur.e2ee_broadcasts SET state = 'cancelled'
      WHERE tenant_id = ${tenantId.value}::uuid AND state = 'pending'
        AND expires_at <= ${now.toISOString()}::timestamptz
    `;
    const messages: UsageCounts = await expiredMessageUsage(transaction, tenantId, now);
    await updatePostgresE2eeUsage(transaction, tenantId, {
      claimCount: -directClaims - broadcasts.recipient_count,
      pendingBroadcastCount: -broadcasts.item_count,
      pendingCiphertextBytes: -broadcasts.ciphertext_bytes,
      pendingDeliveryCount: -broadcasts.recipient_count,
      publicPrekeyCount: -expiredPrekeys,
      retainedCiphertextBytes: -messages.ciphertext_bytes,
      retainedMessageCount: -messages.item_count,
    });
    await cleanupExpiredRows(transaction, tenantId, now);
    return messages.item_count;
  });
}
