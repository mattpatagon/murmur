import type { TransactionSql } from "postgres";
import { z } from "zod";

import {
  type AgentGeneration,
  MAX_RETAINED_SESSIONS_PER_AGENT,
} from "../domain/lifecycle-values.js";
import type { AgentId, Instant, JsonObject, TenantId } from "../domain/value-objects.js";

export type StoredAgentRow = {
  readonly closed_at: string | null;
  readonly close_reason: string | null;
  readonly generation: number;
  readonly metadata_json: string;
};

const StoredAgentRowSchema: z.ZodType<StoredAgentRow> = z.strictObject({
  closed_at: z.string().nullable(),
  close_reason: z.string().nullable(),
  generation: z.number().int().positive(),
  metadata_json: z.string(),
});

export async function endExpiredPostgresSessions(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
  agentId: AgentId | null = null,
): Promise<void> {
  const agentIdValue: string | null = agentId === null ? null : agentId.value;
  await transaction`
    UPDATE murmur.agent_sessions
    SET ended_at = ${now.toISOString()}::timestamptz, end_reason = 'expired'
    WHERE tenant_id = ${tenantId.value}::uuid
      AND (${agentIdValue}::text IS NULL OR agent_id = ${agentIdValue})
      AND ended_at IS NULL
      AND lease_expires_at <= ${now.toISOString()}::timestamptz
  `;
}

export async function trimRetainedPostgresSessions(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<void> {
  await transaction`
    WITH counts AS (
      SELECT COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS live_count
      FROM murmur.agent_sessions
      WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${agentId.value}
    ), ranked AS (
      SELECT generation, session_key,
        ROW_NUMBER() OVER (
          ORDER BY ended_at DESC, generation DESC, session_key DESC
        ) AS ended_rank
      FROM murmur.agent_sessions
      WHERE tenant_id = ${tenantId.value}::uuid
        AND agent_id = ${agentId.value}
        AND ended_at IS NOT NULL
    )
    DELETE FROM murmur.agent_sessions AS target
    USING ranked, counts
    WHERE target.tenant_id = ${tenantId.value}::uuid
      AND target.agent_id = ${agentId.value}
      AND target.generation = ranked.generation
      AND target.session_key = ranked.session_key
      AND ranked.ended_rank > GREATEST(
        ${MAX_RETAINED_SESSIONS_PER_AGENT} - counts.live_count,
        0
      )
  `;
}

export async function postgresLiveSessionCount(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  generation: AgentGeneration,
  now: Instant,
): Promise<number> {
  const raw: unknown = await transaction`
    SELECT COUNT(*)::int AS count FROM murmur.agent_sessions
    WHERE tenant_id = ${tenantId.value}::uuid
      AND agent_id = ${agentId.value}
      AND generation = ${generation.value}
      AND ended_at IS NULL
      AND lease_expires_at > ${now.toISOString()}::timestamptz
  `;
  const rows: { readonly count: number }[] = z
    .array(z.strictObject({ count: z.number().int().nonnegative() }))
    .parse(raw);
  const row: { readonly count: number } | undefined = rows[0];
  return row === undefined ? 0 : row.count;
}

export async function supersedePostgresSessions(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  generation: AgentGeneration,
  now: Instant,
): Promise<void> {
  await transaction`
    UPDATE murmur.agent_sessions
    SET ended_at = ${now.toISOString()}::timestamptz, end_reason = 'superseded'
    WHERE tenant_id = ${tenantId.value}::uuid
      AND agent_id = ${agentId.value}
      AND generation = ${generation.value}
      AND ended_at IS NULL
  `;
}

export function repositoryFromMetadata(metadata: JsonObject): string | null {
  const repository: unknown = metadata["repository"];
  return typeof repository === "string" ? repository : null;
}

export async function storedPostgresAgent(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<StoredAgentRow | null> {
  const raw: unknown = await transaction`
    SELECT generation, closed_at::text AS closed_at, close_reason, metadata::text AS metadata_json
    FROM murmur.agents
    WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${agentId.value}
  `;
  const rows: StoredAgentRow[] = z.array(StoredAgentRowSchema).parse(raw);
  return rows[0] ?? null;
}
