import type { TransactionSql } from "postgres";
import { z } from "zod";

import { AGENT_DORMANCY_DAYS, AGENT_GC_DAYS } from "../domain/lifecycle-values.js";
import type { Instant, TenantId } from "../domain/value-objects.js";

const CountSchema: z.ZodType<readonly { readonly count: number }[]> = z.array(
  z.strictObject({ count: z.number().int().nonnegative() }),
);

function count(raw: unknown): number {
  const row: { readonly count: number } | undefined = CountSchema.parse(raw)[0];
  return row === undefined ? 0 : row.count;
}

export async function prunePostgresLifecycle(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  const timestamp: string = now.toISOString();
  const dormantCutoff: string = now.addDays(-AGENT_DORMANCY_DAYS).toISOString();
  const gcCutoff: string = now.addDays(-AGENT_GC_DAYS).toISOString();
  const expiredRaw: unknown = await transaction`
    WITH updated AS (
      UPDATE murmur.agent_sessions SET ended_at = ${timestamp}::timestamptz,
        end_reason = 'expired'
      WHERE tenant_id = ${tenantId.value}::uuid
        AND ended_at IS NULL AND lease_expires_at <= ${timestamp}::timestamptz
      RETURNING 1
    ) SELECT COUNT(*)::int AS count FROM updated
  `;
  const dormantRaw: unknown = await transaction`
    WITH updated AS (
      UPDATE murmur.agents AS agent SET closed_at = ${timestamp}::timestamptz,
        close_reason = 'dormant'
      WHERE agent.tenant_id = ${tenantId.value}::uuid
        AND agent.closed_at IS NULL
        AND agent.last_seen_at <= ${dormantCutoff}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM murmur.agent_sessions AS session
          WHERE session.tenant_id = agent.tenant_id
            AND session.agent_id = agent.agent_id
            AND session.generation = agent.generation
            AND session.ended_at IS NULL
            AND session.lease_expires_at > ${timestamp}::timestamptz
        )
      RETURNING 1
    ) SELECT COUNT(*)::int AS count FROM updated
  `;
  const sessionsRaw: unknown = await transaction`
    WITH deleted AS (
      DELETE FROM murmur.agent_sessions
      WHERE tenant_id = ${tenantId.value}::uuid
        AND ended_at IS NOT NULL AND ended_at <= ${gcCutoff}::timestamptz
      RETURNING 1
    ) SELECT COUNT(*)::int AS count FROM deleted
  `;
  const agentsRaw: unknown = await transaction`
    WITH deleted AS (
      DELETE FROM murmur.agents AS agent
      WHERE agent.tenant_id = ${tenantId.value}::uuid
        AND agent.closed_at IS NOT NULL AND agent.closed_at <= ${gcCutoff}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM murmur.messages AS message
          WHERE message.tenant_id = agent.tenant_id
            AND (message.sender_id = agent.agent_id OR message.recipient_id = agent.agent_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM murmur.broadcasts AS broadcast
          WHERE broadcast.tenant_id = agent.tenant_id AND broadcast.sender_id = agent.agent_id
        )
      RETURNING 1
    ) SELECT COUNT(*)::int AS count FROM deleted
  `;
  return count(expiredRaw) + count(dormantRaw) + count(sessionsRaw) + count(agentsRaw);
}
