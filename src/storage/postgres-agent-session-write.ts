import type { TransactionSql } from "postgres";

import {
  AGENT_LEASE_MINUTES,
  type AgentGeneration,
  type SessionKey,
} from "../domain/lifecycle-values.js";
import type { AgentId, Instant, TenantId } from "../domain/value-objects.js";

export async function upsertPostgresAgentSession(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  generation: AgentGeneration,
  sessionKey: SessionKey,
  now: Instant,
): Promise<void> {
  await transaction`
    INSERT INTO murmur.agent_sessions(
      tenant_id, agent_id, generation, session_key,
      started_at, last_renewed_at, lease_expires_at
    ) VALUES (
      ${tenantId.value}::uuid, ${agentId.value}, ${generation.value}, ${sessionKey.value},
      ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz,
      ${now.addMinutes(AGENT_LEASE_MINUTES).toISOString()}::timestamptz
    )
    ON CONFLICT(tenant_id, agent_id, generation, session_key) DO UPDATE SET
      last_renewed_at = excluded.last_renewed_at,
      lease_expires_at = excluded.lease_expires_at,
      ended_at = NULL,
      end_reason = NULL
  `;
}
