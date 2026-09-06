import type { Database } from "bun:sqlite";

import type { ListAgentsQuery, ListAgentsResult } from "../domain/models.js";
import type { Instant } from "../domain/value-objects.js";
import {
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";
import {
  AGENT_METADATA_MULTIPLIER,
  AGENT_PAGE_ROW_BYTES,
  type BudgetedAgentPage,
  MAX_AGENT_PAGE_BYTES,
  parseBudgetedAgentPage,
} from "./agent-page-budget.js";
import { endExpiredSqliteSessions } from "./sqlite-agent-session-rows.js";
import { mapAgentRow } from "./sqlite-message-rows.js";

type AgentPageBindings = [
  string,
  string,
  string,
  string,
  string,
  string,
  string | null,
  string | null,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export function listSqliteAgents(
  database: Database,
  query: ListAgentsQuery,
  now: Instant,
): ListAgentsResult {
  return database.transaction((): ListAgentsResult => {
    endExpiredSqliteSessions(database, now);
    const timestamp: string = now.toISOString();
    const cursor: string | null = query.cursor === null ? null : query.cursor.value;
    const reservation: MaterializationReservation =
      reserveMaterializationBytes(MAX_AGENT_PAGE_BYTES);
    try {
      const rows: unknown[] = database
        .query<unknown, AgentPageBindings>(`
      WITH projected AS (
        SELECT
          agent.*,
          (SELECT COUNT(*) FROM agent_sessions AS session WHERE session.agent_id = agent.agent_id
              AND session.generation = agent.generation
              AND session.ended_at IS NULL
              AND session.lease_expires_at > ?) AS live_session_count,
          (SELECT MAX(session.lease_expires_at) FROM agent_sessions AS session WHERE session.agent_id = agent.agent_id
              AND session.generation = agent.generation
              AND session.ended_at IS NULL
              AND session.lease_expires_at > ?) AS lease_expires_at,
          CASE
            WHEN agent.closed_at IS NOT NULL THEN 'closed'
            WHEN EXISTS (
              SELECT 1 FROM agent_sessions AS session
              WHERE session.agent_id = agent.agent_id
                AND session.generation = agent.generation
                AND session.ended_at IS NULL
                AND session.lease_expires_at > ?
            ) THEN 'active'
            ELSE 'inactive'
          END AS state
        FROM agents AS agent
      )
      , candidate AS MATERIALIZED (
      SELECT * FROM projected
      WHERE (? = 'all' OR (? = 'open' AND state != 'closed') OR state = ?)
        AND (? IS NULL OR agent_id > ?)
      ORDER BY agent_id ASC
      LIMIT ?

      ), metered AS (
        SELECT candidate.*,
          ROW_NUMBER() OVER (ORDER BY agent_id ASC) AS page_row,
          SUM(length(CAST(metadata_json AS BLOB)) * ? + ?)
            OVER (ORDER BY agent_id ASC) AS estimated_page_bytes
        FROM candidate
      )
      SELECT CASE WHEN page_row <= ? AND estimated_page_bytes <= ?
        THEN json_object(
          'agent_id', agent_id, 'authority', authority, 'closed_at', closed_at,
          'close_reason', close_reason, 'created_at', created_at,
          'display_name', display_name, 'generation', generation,
          'last_seen_at', last_seen_at, 'lease_expires_at', lease_expires_at,
          'live_session_count', live_session_count, 'metadata_json', metadata_json,
          'state', state
        ) ELSE NULL END AS row_json,
        CASE WHEN page_row <= ? AND estimated_page_bytes <= ?
          THEN estimated_page_bytes ELSE 0 END AS estimated_page_bytes
      FROM metered ORDER BY agent_id ASC
    `)
        .all(
          timestamp,
          timestamp,
          timestamp,
          query.state,
          query.state,
          query.state,
          cursor,
          cursor,
          query.limit + 1,
          AGENT_METADATA_MULTIPLIER,
          AGENT_PAGE_ROW_BYTES,
          query.limit,
          MAX_AGENT_PAGE_BYTES,
          query.limit,
          MAX_AGENT_PAGE_BYTES,
        );
      const page: BudgetedAgentPage = parseBudgetedAgentPage(rows, mapAgentRow, query.limit);
      reservation.settle(page.bytes);
      return page.result;
    } catch (error: unknown) {
      reservation.fail();
      throw error;
    }
  })();
}
