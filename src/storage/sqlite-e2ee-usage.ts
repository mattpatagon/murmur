import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

import {
  applyE2eeUsageDelta,
  type E2eeTenantUsage,
  type E2eeTenantUsageDelta,
} from "./e2ee-usage.js";

const IntegerSchema: z.ZodPipe<
  z.ZodUnion<readonly [z.ZodNumber, z.ZodBigInt]>,
  z.ZodTransform<number, number | bigint>
> = z
  .union([z.number().int(), z.bigint()])
  .transform((value: number | bigint): number => Number(value));

const UsageRowSchema: z.ZodType<{
  readonly claim_count: number;
  readonly pending_broadcast_count: number;
  readonly pending_ciphertext_bytes: number;
  readonly pending_delivery_count: number;
  readonly public_prekey_count: number;
  readonly retained_ciphertext_bytes: number;
  readonly retained_message_count: number;
}> = z.strictObject({
  claim_count: IntegerSchema,
  pending_broadcast_count: IntegerSchema,
  pending_ciphertext_bytes: IntegerSchema,
  pending_delivery_count: IntegerSchema,
  public_prekey_count: IntegerSchema,
  retained_ciphertext_bytes: IntegerSchema,
  retained_message_count: IntegerSchema,
});

export function readSqliteE2eeUsage(database: Database): E2eeTenantUsage {
  const row: z.infer<typeof UsageRowSchema> = UsageRowSchema.parse(
    database
      .query<unknown, []>(`
        SELECT claim_count, pending_broadcast_count, pending_ciphertext_bytes,
          pending_delivery_count, public_prekey_count, retained_ciphertext_bytes,
          retained_message_count
        FROM e2ee_usage WHERE singleton = 1
      `)
      .get(),
  );
  return {
    claimCount: row.claim_count,
    pendingBroadcastCount: row.pending_broadcast_count,
    pendingCiphertextBytes: row.pending_ciphertext_bytes,
    pendingDeliveryCount: row.pending_delivery_count,
    publicPrekeyCount: row.public_prekey_count,
    retainedCiphertextBytes: row.retained_ciphertext_bytes,
    retainedMessageCount: row.retained_message_count,
  };
}

export function updateSqliteE2eeUsage(
  database: Database,
  delta: E2eeTenantUsageDelta,
): E2eeTenantUsage {
  const next: E2eeTenantUsage = applyE2eeUsageDelta(readSqliteE2eeUsage(database), delta);
  const statement: Statement<unknown, [number, number, number, number, number, number, number]> =
    database.query(`
    UPDATE e2ee_usage SET
      claim_count = ?,
      pending_broadcast_count = ?,
      pending_ciphertext_bytes = ?,
      pending_delivery_count = ?,
      public_prekey_count = ?,
      retained_ciphertext_bytes = ?,
      retained_message_count = ?
    WHERE singleton = 1
  `);
  statement.run(
    next.claimCount,
    next.pendingBroadcastCount,
    next.pendingCiphertextBytes,
    next.pendingDeliveryCount,
    next.publicPrekeyCount,
    next.retainedCiphertextBytes,
    next.retainedMessageCount,
  );
  return next;
}
