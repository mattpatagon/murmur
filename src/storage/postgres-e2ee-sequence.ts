import type { TransactionSql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";
import { PostgresE2eeVersionRowSchema } from "./postgres-e2ee-rows.js";

export async function allocatePostgresE2eeSequences(
  transaction: TransactionSql,
  tenantId: TenantId,
  count: number,
): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error("Encrypted sequence allocation is invalid");
  }
  const raw: unknown = await transaction`
    INSERT INTO murmur.tenant_message_sequences AS counter(tenant_id, last_sequence)
    VALUES (${tenantId.value}::uuid, ${count})
    ON CONFLICT(tenant_id) DO UPDATE
    SET last_sequence = counter.last_sequence + ${count}
    RETURNING last_sequence AS version
  `;
  const rows: { readonly version: number }[] = z.array(PostgresE2eeVersionRowSchema).parse(raw);
  const row: { readonly version: number } | undefined = rows[0];
  if (row === undefined) throw new Error("Encrypted sequence allocation failed");
  return row.version - count + 1;
}
