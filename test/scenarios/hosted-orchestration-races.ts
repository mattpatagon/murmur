import { expect } from "bun:test";

import { type RevokeTokenOutput, RevokeTokenOutputSchema } from "../../src/hosted/contracts.js";
import {
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type ClearOrchestratorPolicyOutput,
  ClearOrchestratorPolicyOutputSchema,
} from "../../src/hosted/orchestration-contracts.js";
import { callTool } from "../support/hosted-mcp-harness.js";
import { runSerializedAuthorityMutation } from "../support/orchestration-race-harness.js";
import type { Worker } from "./hosted-orchestration-helpers.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyClearSerialization(options: {
  readonly bossAgentId: string;
  readonly policyId: string;
  readonly repository: string;
  readonly scenario: HostedTenantScenario;
  readonly worker: Worker;
}): Promise<ClearOrchestratorPolicyOutput> {
  const scenario: HostedTenantScenario = options.scenario;
  const race: readonly [AskOrchestratorOutput, ClearOrchestratorPolicyOutput] =
    await runSerializedAuthorityMutation({
      ask: async (): Promise<AskOrchestratorOutput> =>
        await callTool(
          scenario.server.mcpUrl,
          options.worker.token.token.secret,
          options.worker.session,
          517,
          "ask_orchestrator",
          {
            content: "Admit this request before the policy clear returns.",
            idempotency_key: `orchestration-clear-race-${scenario.unique}`,
            sender_id: scenario.senderA,
          },
          AskOrchestratorOutputSchema,
        ),
      databaseUrl: scenario.configuredAdminDatabaseUrl,
      mutate: async (): Promise<ClearOrchestratorPolicyOutput> =>
        await callTool(
          scenario.server.mcpUrl,
          scenario.tenantA.token.secret,
          scenario.adminASession,
          518,
          "clear_orchestrator_policy",
          {
            personal_id: scenario.agentAToken.token.personal_id,
            repository: options.repository,
            scope_kind: "personal",
          },
          ClearOrchestratorPolicyOutputSchema,
        ),
      mutationQueryFragment: "UPDATE murmur.orchestrator_policies",
      recipientId: options.bossAgentId,
      tenantId: scenario.tenantA.tenant.tenant_id,
    });
  expect(race[0].duplicate).toBe(false);
  expect(race[0].message.orchestrator_policy_id).toBe(options.policyId);
  return race[1];
}

export async function verifyRevokeSerialization(options: {
  readonly bossAgentId: string;
  readonly bossKeyId: string;
  readonly scenario: HostedTenantScenario;
  readonly worker: Worker;
}): Promise<RevokeTokenOutput> {
  const scenario: HostedTenantScenario = options.scenario;
  const race: readonly [AskOrchestratorOutput, RevokeTokenOutput] =
    await runSerializedAuthorityMutation({
      ask: async (): Promise<AskOrchestratorOutput> =>
        await callTool(
          scenario.server.mcpUrl,
          options.worker.token.token.secret,
          options.worker.session,
          522,
          "ask_orchestrator",
          {
            content: "Admit this request before credential revocation returns.",
            idempotency_key: `orchestration-revoke-race-${scenario.unique}`,
            sender_id: scenario.senderA,
          },
          AskOrchestratorOutputSchema,
        ),
      databaseUrl: scenario.configuredAdminDatabaseUrl,
      mutate: async (): Promise<RevokeTokenOutput> =>
        await callTool(
          scenario.server.mcpUrl,
          scenario.tenantA.token.secret,
          scenario.adminASession,
          523,
          "revoke_access_token",
          { key_id: options.bossKeyId },
          RevokeTokenOutputSchema,
        ),
      mutationQueryFragment: "UPDATE murmur.access_tokens",
      recipientId: options.bossAgentId,
      tenantId: scenario.tenantA.tenant.tenant_id,
    });
  expect(race[0].duplicate).toBe(false);
  expect(race[0].orchestrator.agent_id).toBe(options.bossAgentId);
  return race[1];
}
