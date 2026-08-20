import type { Database } from "bun:sqlite";

import { AGENT_DORMANCY_DAYS, AGENT_GC_DAYS } from "../domain/lifecycle-values.js";
import type { Instant } from "../domain/value-objects.js";

export function pruneSqliteLifecycle(database: Database, now: Instant): number {
  const timestamp: string = now.toISOString();
  const dormantCutoff: string = now.addDays(-AGENT_DORMANCY_DAYS).toISOString();
  const gcCutoff: string = now.addDays(-AGENT_GC_DAYS).toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const expiredSessions: number = database
      .query<unknown, [string, string]>(`
        UPDATE agent_sessions SET ended_at = ?, end_reason = 'expired'
        WHERE ended_at IS NULL AND lease_expires_at <= ?
      `)
      .run(timestamp, timestamp).changes;
    const dormantAgents: number = database
      .query<unknown, [string, string, string]>(`
        UPDATE agents SET closed_at = ?, close_reason = 'dormant'
        WHERE closed_at IS NULL AND last_seen_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM agent_sessions AS session
            WHERE session.agent_id = agents.agent_id
              AND session.generation = agents.generation
              AND session.ended_at IS NULL
              AND session.lease_expires_at > ?
          )
      `)
      .run(timestamp, dormantCutoff, timestamp).changes;
    const deletedSessions: number = database
      .query<unknown, [string]>(`
        DELETE FROM agent_sessions WHERE rowid IN (
          SELECT rowid FROM agent_sessions
          WHERE ended_at IS NOT NULL AND ended_at <= ?
          ORDER BY ended_at ASC, agent_id ASC, generation ASC, session_key ASC
          LIMIT 1000
        )
      `)
      .run(gcCutoff).changes;
    const deletedAgents: number = database
      .query<unknown, [string]>(`
        DELETE FROM agents WHERE agent_id IN (
          SELECT agent_id FROM agents AS candidate
          WHERE candidate.closed_at IS NOT NULL AND candidate.closed_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM messages
            WHERE sender_id = candidate.agent_id OR recipient_id = candidate.agent_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM broadcasts WHERE sender_id = candidate.agent_id
          )
          AND NOT EXISTS (SELECT 1 FROM notices WHERE creator_id = candidate.agent_id)
          AND NOT EXISTS (SELECT 1 FROM notices WHERE resolved_by_id = candidate.agent_id)
          AND NOT EXISTS (SELECT 1 FROM notices WHERE withdrawn_by_id = candidate.agent_id)
          AND NOT EXISTS (
            SELECT 1 FROM feedback_submissions WHERE reporter_id = candidate.agent_id
          )
          ORDER BY candidate.closed_at ASC, candidate.agent_id ASC
          LIMIT 1000
        )
      `)
      .run(gcCutoff).changes;
    database.exec("COMMIT");
    return expiredSessions + dormantAgents + deletedSessions + deletedAgents;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
