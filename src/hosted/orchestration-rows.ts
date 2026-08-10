import { z } from "zod";

import { OrchestratorPolicyId, PersonalId } from "../domain/orchestration.js";
import { AgentId, Instant, RepositoryName } from "../domain/value-objects.js";
import type {
  EffectiveOrchestrator,
  OrchestratorPolicy,
  OrchestratorScope,
} from "./control-plane-contracts.js";

export type OrchestratorPolicyRow = {
  readonly created_at: string;
  readonly created_by_token_id: string;
  readonly enabled: boolean;
  readonly instructions: string;
  readonly orchestrator_agent_id: string;
  readonly orchestrator_token_id: string;
  readonly policy_id: string;
  readonly repository_name: string;
  readonly scope_kind: "organization" | "personal";
  readonly scope_owner_id: string;
  readonly updated_at: string;
  readonly updated_by_token_id: string;
};

export const OrchestratorPolicyRowSchema: z.ZodType<OrchestratorPolicyRow> = z.strictObject({
  created_at: z.string(),
  created_by_token_id: z.string().uuid(),
  enabled: z.boolean(),
  instructions: z.string(),
  orchestrator_agent_id: z.string(),
  orchestrator_token_id: z.string().uuid(),
  policy_id: z.string().uuid(),
  repository_name: z.string(),
  scope_kind: z.enum(["organization", "personal"]),
  scope_owner_id: z.string().uuid(),
  updated_at: z.string(),
  updated_by_token_id: z.string().uuid(),
});

function mapScope(row: OrchestratorPolicyRow): OrchestratorScope {
  return {
    kind: row.scope_kind,
    personalId: row.scope_kind === "personal" ? PersonalId.parse(row.scope_owner_id) : null,
    repositoryName: row.repository_name === "" ? null : RepositoryName.parse(row.repository_name),
  };
}

export function mapOrchestratorPolicy(row: OrchestratorPolicyRow): OrchestratorPolicy {
  return {
    createdAt: Instant.parse(row.created_at),
    createdByTokenId: row.created_by_token_id,
    enabled: row.enabled,
    instructions: row.instructions,
    orchestratorAgentId: AgentId.parse(row.orchestrator_agent_id),
    orchestratorTokenId: row.orchestrator_token_id,
    policyId: OrchestratorPolicyId.parse(row.policy_id),
    scope: mapScope(row),
    updatedAt: Instant.parse(row.updated_at),
    updatedByTokenId: row.updated_by_token_id,
  };
}

export function toEffectiveOrchestrator(policy: OrchestratorPolicy): EffectiveOrchestrator {
  return {
    orchestratorAgentId: policy.orchestratorAgentId,
    policyId: policy.policyId,
    scope: policy.scope,
  };
}
