import type { Sql, TransactionSql } from "postgres";

import type { Agent, ListAgentsQuery, ListAgentsResult } from "../domain/models.js";
import type { Instant, TenantId } from "../domain/value-objects.js";
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
import { endExpiredPostgresSessions } from "./postgres-agent-lifecycle-rows.js";
import { AgentRowSchema, mapAgentRow } from "./postgres-message-rows.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

export async function listPostgresAgents(
  database: Sql,
  tenantId: TenantId,
  query: ListAgentsQuery,
  now: Instant,
): Promise<ListAgentsResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<ListAgentsResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await endExpiredPostgresSessions(transaction, tenantId, now);
    const cursor: string | null = query.cursor === null ? null : query.cursor.value;
    const reservation: MaterializationReservation =
      reserveMaterializationBytes(MAX_AGENT_PAGE_BYTES);
    try {
      const raw: unknown = await transaction`
      WITH candidate AS MATERIALIZED (
      SELECT
        agent.agent_id,
        agent.authority,
        agent.display_name,
        agent.metadata::text AS metadata_json,
        agent.generation,
        agent.close_reason,
        to_char(agent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(agent.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at,
        CASE WHEN agent.closed_at IS NULL THEN NULL ELSE
          to_char(agent.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS closed_at,
        session.live_session_count,
        session.lease_expires_at,
        CASE
          WHEN agent.closed_at IS NOT NULL THEN 'closed'
          WHEN session.live_session_count > 0 THEN 'active'
          ELSE 'inactive'
        END AS state
      FROM murmur.agents AS agent
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::int AS live_session_count,
          CASE WHEN MAX(lease_expires_at) IS NULL THEN NULL ELSE
            to_char(MAX(lease_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS lease_expires_at
        FROM murmur.agent_sessions AS current_session
        WHERE current_session.tenant_id = agent.tenant_id
          AND current_session.agent_id = agent.agent_id
          AND current_session.generation = agent.generation
          AND current_session.ended_at IS NULL
          AND current_session.lease_expires_at > ${now.toISOString()}::timestamptz
      ) AS session
      WHERE agent.tenant_id = ${tenantId.value}::uuid AND (
        ${query.state} = 'all'
        OR (${query.state} = 'open' AND agent.closed_at IS NULL)
        OR (${query.state} = 'closed' AND agent.closed_at IS NOT NULL)
        OR (${query.state} = 'active' AND agent.closed_at IS NULL
          AND session.live_session_count > 0)
        OR (${query.state} = 'inactive' AND agent.closed_at IS NULL
          AND session.live_session_count = 0)
      )
      AND (${cursor}::text IS NULL OR agent.agent_id > ${cursor}::text)
      ORDER BY agent.agent_id ASC
      LIMIT ${query.limit + 1}

      ), metered AS (
        SELECT candidate.*,
          ROW_NUMBER() OVER (ORDER BY agent_id ASC) AS page_row,
          SUM(octet_length(metadata_json) * ${AGENT_METADATA_MULTIPLIER}
            + ${AGENT_PAGE_ROW_BYTES}) OVER (ORDER BY agent_id ASC) AS estimated_page_bytes
        FROM candidate
      )
      SELECT CASE WHEN page_row <= ${query.limit}
          AND estimated_page_bytes <= ${MAX_AGENT_PAGE_BYTES}
        THEN (to_jsonb(metered) - 'page_row' - 'estimated_page_bytes')::text
        ELSE NULL END AS row_json,
        CASE WHEN page_row <= ${query.limit}
          AND estimated_page_bytes <= ${MAX_AGENT_PAGE_BYTES}
        THEN estimated_page_bytes ELSE 0 END AS estimated_page_bytes
      FROM metered ORDER BY agent_id ASC
    `;
      const page: BudgetedAgentPage = parseBudgetedAgentPage(
        raw,
        (value: unknown): Agent => mapAgentRow(AgentRowSchema.parse(value)),
        query.limit,
      );
      reservation.settle(page.bytes);
      return page.result;
    } catch (error: unknown) {
      reservation.fail();
      throw error;
    }
  });
}
