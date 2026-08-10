import type { Sql, TransactionSql } from "postgres";

import type { TenantId } from "../domain/value-objects.js";

// biome-ignore lint/security/noSecrets: This public constant namespaces a Postgres advisory lock.
export const POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED: string = "671255459461899938";

export async function setPostgresTenantContext(
  transaction: TransactionSql,
  tenantId: TenantId,
): Promise<void> {
  await transaction`
    SELECT pg_catalog.set_config('murmur.tenant_id', ${tenantId.value}, true)
  `;
}

export async function lockPostgresRecipientCommitOrder(
  database: Sql,
  transaction: TransactionSql,
  tenantId: TenantId,
  recipientIds: readonly string[],
): Promise<void> {
  if (recipientIds.length === 0) return;
  const orderedRecipientIds: string[] = Array.from(new Set(recipientIds)).sort();
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${tenantId.value}::text || ':' || recipient.agent_id,
        ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
      )
    )
    FROM unnest(${database.array(orderedRecipientIds)}::text[])
      WITH ORDINALITY AS recipient(agent_id, position)
    ORDER BY recipient.position
  `;
}
