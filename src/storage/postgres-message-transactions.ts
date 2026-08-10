import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { AgentAuthorityError, UnknownAgentError } from "../domain/errors.js";
import type { SenderAuthority } from "../domain/orchestration.js";
import type { AgentId, TenantId } from "../domain/value-objects.js";

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

export async function requirePostgresAgents(
  transaction: TransactionSql,
  tenantId: TenantId,
  senderId: AgentId,
  recipientId: AgentId,
  senderAuthority: SenderAuthority,
): Promise<void> {
  const rawRows: unknown = await transaction`
    SELECT agent_id, authority
    FROM murmur.agents
    WHERE tenant_id = ${tenantId.value}::uuid
      AND (agent_id = ${senderId.value} OR agent_id = ${recipientId.value})
  `;
  const rows: { readonly agent_id: string; readonly authority: SenderAuthority }[] = z
    .array(z.strictObject({ agent_id: z.string(), authority: z.enum(["peer", "orchestrator"]) }))
    .parse(rawRows);
  const knownIds: Set<string> = new Set<string>(
    rows.map((row: { readonly agent_id: string }): string => row.agent_id),
  );
  if (!knownIds.has(senderId.value)) throw new UnknownAgentError(senderId.value);
  if (!knownIds.has(recipientId.value)) throw new UnknownAgentError(recipientId.value);
  const sender: { readonly agent_id: string; readonly authority: SenderAuthority } | undefined =
    rows.find(
      (row: { readonly agent_id: string; readonly authority: SenderAuthority }): boolean =>
        row.agent_id === senderId.value,
    );
  if (sender === undefined || sender.authority !== senderAuthority) throw new AgentAuthorityError();
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
