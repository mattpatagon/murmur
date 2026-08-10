import type { Sql, TransactionSql } from "postgres";

import { setPostgresTenantContext } from "../storage/postgres-message-transactions.js";
import type { OrchestratorPolicy, Page, TenantPrincipal } from "./control-plane-contracts.js";
import { page } from "./control-plane-rows.js";
import { mapOrchestratorPolicy, OrchestratorPolicyRowSchema } from "./orchestration-rows.js";

export async function listPostgresOrchestratorPolicies(
  database: Sql,
  principal: TenantPrincipal,
  cursor: string | null,
  limit: number,
): Promise<Page<OrchestratorPolicy>> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<Page<OrchestratorPolicy>> => {
      await setPostgresTenantContext(transaction, principal.tenantId);
      const rawRows: unknown = await transaction`
      SELECT
        policy.policy_id::text AS policy_id, policy.scope_kind,
        policy.scope_owner_id::text AS scope_owner_id, policy.repository_name,
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
        AND (
          ${cursor}::uuid IS NULL
          OR (policy.scope_kind, policy.scope_owner_id, policy.repository_name, policy.policy_id) > (
            SELECT
              cursor_policy.scope_kind, cursor_policy.scope_owner_id,
              cursor_policy.repository_name, cursor_policy.policy_id
            FROM murmur.orchestrator_policies AS cursor_policy
            WHERE cursor_policy.tenant_id = ${principal.tenantId.value}::uuid
              AND cursor_policy.policy_id = ${cursor}::uuid
          )
        )
      ORDER BY policy.scope_kind, policy.scope_owner_id, policy.repository_name, policy.policy_id
      LIMIT ${limit + 1}
    `;
      const policies: readonly OrchestratorPolicy[] = OrchestratorPolicyRowSchema.array()
        .parse(rawRows)
        .map(mapOrchestratorPolicy);
      return page(policies, limit, (policy: OrchestratorPolicy): string => policy.policyId.value);
    },
  );
}
