import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { UnknownAgentError } from "../domain/errors.js";
import type { AgentId, TenantId } from "../domain/value-objects.js";

export const POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED: string = "671255459461899938";

export async function setPostgresTenantContext(
  transaction: TransactionSql,
  tenantId: TenantId,
): Promise<void> {
  await transaction`
    SELECT pg_catalog.set_config('murmur.tenant_id', ${tenantId.value}, true)
  `;
}

export async function requirePostgresAgents(
  transaction: TransactionSql,
  tenantId: TenantId,
  senderId: AgentId,
  recipientId: AgentId,
): Promise<void> {
  const rawRows: unknown = await transaction`
    SELECT agent_id
    FROM murmur.agents
    WHERE tenant_id = ${tenantId.value}::uuid
      AND (agent_id = ${senderId.value} OR agent_id = ${recipientId.value})
  `;
  const rows: { readonly agent_id: string }[] = z
    .array(z.strictObject({ agent_id: z.string() }))
    .parse(rawRows);
  const knownIds: Set<string> = new Set<string>(
    rows.map((row: { readonly agent_id: string }): string => row.agent_id),
  );
  if (!knownIds.has(senderId.value)) throw new UnknownAgentError(senderId.value);
  if (!knownIds.has(recipientId.value)) throw new UnknownAgentError(recipientId.value);
}

export async function lockPostgresRecipientCommitOrder(
  database: Sql,
  transaction: TransactionSql,
  tenantId: TenantId,
  recipientIds: readonly string[],
): Promise<void> {
  if (recipientIds.length === 0) return;
  const orderedRecipientIds: string[] = Array.from(recipientIds);
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
