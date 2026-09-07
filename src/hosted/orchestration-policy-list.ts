import type { Sql, TransactionSql } from "postgres";

import {
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";
import { setPostgresTenantContext } from "../storage/postgres-message-transactions.js";
import type { OrchestratorPolicy, Page, TenantPrincipal } from "./control-plane-contracts.js";
import {
  type BudgetedPolicyPage,
  MAX_POLICY_PAGE_BYTES,
  POLICY_INSTRUCTIONS_MULTIPLIER,
  POLICY_PAGE_ROW_BYTES,
  PolicyPageLimitSchema,
  parseBudgetedPolicyPage,
} from "./orchestration-policy-page.js";

export async function listPostgresOrchestratorPolicies(
  database: Sql,
  principal: TenantPrincipal,
  cursor: string | null,
  limit: number,
): Promise<Page<OrchestratorPolicy>> {
  const boundedLimit: number = PolicyPageLimitSchema.parse(limit);
  const reservation: MaterializationReservation =
    reserveMaterializationBytes(MAX_POLICY_PAGE_BYTES);
  let retainedBytes: number = 0;
  try {
    const result: Page<OrchestratorPolicy> = await database.begin(
      async (transaction: TransactionSql): Promise<Page<OrchestratorPolicy>> => {
        await setPostgresTenantContext(transaction, principal.tenantId);
        const rawRows: unknown = await transaction`
      WITH candidate AS MATERIALIZED (
      SELECT policy.policy_id, policy.scope_kind, policy.scope_owner_id, policy.repository_name,
        policy.machine_name,
        octet_length(policy.instructions) * ${POLICY_INSTRUCTIONS_MULTIPLIER}
          + ${POLICY_PAGE_ROW_BYTES} AS row_bytes
      FROM murmur.orchestrator_policies AS policy
      JOIN murmur.access_tokens AS token
        ON token.tenant_id = policy.tenant_id
        AND token.token_id = policy.orchestrator_token_id
      WHERE policy.tenant_id = ${principal.tenantId.value}::uuid
        AND (
          ${cursor}::uuid IS NULL
          OR (
            policy.scope_kind, policy.scope_owner_id, policy.repository_name,
            policy.machine_name, policy.policy_id
          ) > (
            SELECT
              cursor_policy.scope_kind, cursor_policy.scope_owner_id,
              cursor_policy.repository_name, cursor_policy.machine_name, cursor_policy.policy_id
            FROM murmur.orchestrator_policies AS cursor_policy
            WHERE cursor_policy.tenant_id = ${principal.tenantId.value}::uuid
              AND cursor_policy.policy_id = ${cursor}::uuid
          )
        )
      ORDER BY policy.scope_kind, policy.scope_owner_id, policy.repository_name,
        policy.machine_name, policy.policy_id
      LIMIT ${boundedLimit + 1}
      ), metered AS MATERIALIZED (
        SELECT policy_id,
          row_number() OVER policy_order AS page_row,
          sum(row_bytes) OVER policy_order AS estimated_page_bytes
        FROM candidate
        WINDOW policy_order AS (
          ORDER BY scope_kind, scope_owner_id, repository_name, machine_name, policy_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )
      ), fitting AS MATERIALIZED (
        SELECT * FROM metered WHERE page_row <= ${boundedLimit}
          AND estimated_page_bytes <= ${MAX_POLICY_PAGE_BYTES}
      )
      SELECT fitting.policy_id::text AS policy_id, fitting.page_row,
        fitting.estimated_page_bytes, row_to_json(payload)::text AS row_json
      FROM fitting
      JOIN LATERAL (
        SELECT
          policy.policy_id::text AS policy_id, policy.scope_kind,
          policy.scope_owner_id::text AS scope_owner_id, policy.repository_name,
          policy.machine_name,
          policy.orchestrator_token_id::text AS orchestrator_token_id,
          token.orchestrator_agent_id, policy.instructions, policy.enabled,
          policy.created_by_token_id::text AS created_by_token_id,
          policy.updated_by_token_id::text AS updated_by_token_id,
          to_char(policy.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(policy.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM murmur.orchestrator_policies AS policy
        JOIN murmur.access_tokens AS token
          ON token.tenant_id = policy.tenant_id
          AND token.token_id = policy.orchestrator_token_id
        WHERE policy.tenant_id = ${principal.tenantId.value}::uuid
          AND policy.policy_id = fitting.policy_id
      ) AS payload ON true
      UNION ALL
      SELECT policy_id::text, page_row, 0::bigint AS estimated_page_bytes, NULL::text AS row_json
      FROM metered
      WHERE page_row > ${boundedLimit} OR estimated_page_bytes > ${MAX_POLICY_PAGE_BYTES}
      ORDER BY page_row
    `;
        const parsed: BudgetedPolicyPage = parseBudgetedPolicyPage(rawRows, boundedLimit);
        retainedBytes = parsed.bytes;
        return parsed.result;
      },
    );
    reservation.settle(retainedBytes);
    return result;
  } catch (error: unknown) {
    reservation.fail();
    throw error;
  }
}
