import type { Database } from "bun:sqlite";

import {
  type AgentGeneration,
  MAX_RETAINED_SESSIONS_PER_AGENT,
} from "../domain/lifecycle-values.js";
import type { AgentId, Instant } from "../domain/value-objects.js";

export function endExpiredSqliteSessions(
  database: Database,
  now: Instant,
  agentId: AgentId | null = null,
): void {
  if (agentId === null) {
    database
      .query<unknown, [string, string]>(`
        UPDATE agent_sessions
        SET ended_at = ?, end_reason = 'expired'
        WHERE ended_at IS NULL AND lease_expires_at <= ?
      `)
      .run(now.toISOString(), now.toISOString());
    return;
  }
  database
    .query<unknown, [string, string, string]>(`
      UPDATE agent_sessions
      SET ended_at = ?, end_reason = 'expired'
      WHERE agent_id = ? AND ended_at IS NULL AND lease_expires_at <= ?
    `)
    .run(now.toISOString(), agentId.value, now.toISOString());
}

export function sqliteLiveSessionCount(
  database: Database,
  agentId: AgentId,
  generation: AgentGeneration,
  now: Instant,
): number {
  const row: unknown = database
    .query<unknown, [string, number, string]>(`
      SELECT COUNT(*) AS count FROM agent_sessions
      WHERE agent_id = ? AND generation = ? AND ended_at IS NULL AND lease_expires_at > ?
    `)
    .get(agentId.value, generation.value, now.toISOString());
  if (row === null || typeof row !== "object") throw new Error("Session count is invalid");
  const value: unknown = Reflect.get(row, "count");
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("Session count is invalid");
  }
  return Number(value);
}

export function trimRetainedSqliteSessions(database: Database, agentId: AgentId): void {
  database
    .query<unknown, [string, number, string]>(`
      DELETE FROM agent_sessions
      WHERE rowid IN (
        SELECT rowid FROM agent_sessions
        WHERE agent_id = ? AND ended_at IS NOT NULL
        ORDER BY ended_at DESC, generation DESC, session_key DESC
        LIMIT -1 OFFSET MAX(
          ? - (
            SELECT COUNT(*) FROM agent_sessions
            WHERE agent_id = ? AND ended_at IS NULL
          ),
          0
        )
      )
    `)
    .run(agentId.value, MAX_RETAINED_SESSIONS_PER_AGENT, agentId.value);
}
