import { expect } from "bun:test";
import { randomUUID } from "node:crypto";

import { type RevokeTokenOutput, RevokeTokenOutputSchema } from "../../src/hosted/contracts.js";
import {
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type CreateOrchestratorTokenOutput,
  CreateOrchestratorTokenOutputSchema,
  type ListOrchestratorPoliciesOutput,
  ListOrchestratorPoliciesOutputSchema,
  type OrchestratorPolicyDto,
  type SetOrchestratorPolicyOutput,
  SetOrchestratorPolicyOutputSchema,
} from "../../src/hosted/orchestration-contracts.js";
import { callTool, callToolExpectingError } from "../support/hosted-mcp-harness.js";
import { runConcurrentPolicyUpdates } from "../support/orchestration-race-harness.js";
import type { Worker } from "./hosted-orchestration-helpers.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyPersonalPolicyOwnership(
  scenario: HostedTenantScenario,
  bossKeyId: string,
): Promise<void> {
  const personalIds: readonly string[] = [randomUUID(), scenario.agentBToken.token.personal_id];
  for (const [index, personalId] of personalIds.entries()) {
    const error: string = await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.tenantA.token.secret,
      scenario.adminASession,
      700 + index,
      "set_orchestrator_policy",
      {
        instructions: `Unavailable personal scope ${String(index)}`,
        orchestrator_key_id: bossKeyId,
        personal_id: personalId,
        scope_kind: "personal",
      },
    );
    expect(error).toContain("personal identity is unavailable in this tenant");
  }
}

function policyTuple(policy: OrchestratorPolicyDto): string {
  return `${policy.agent_id}\u0000${policy.orchestrator_token_id}\u0000${policy.instructions}`;
}

export async function verifyConcurrentSameScopePolicies(options: {
  readonly bossAgentId: string;
  readonly bossKeyId: string;
  readonly bossTokenId: string;
  readonly scenario: HostedTenantScenario;
}): Promise<void> {
  const scenario: HostedTenantScenario = options.scenario;
  const raceBossAgentId: string = `policy-race-boss-${scenario.unique}`;
  const raceBoss: CreateOrchestratorTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    702,
    "create_orchestrator_token",
    { agent_id: raceBossAgentId, name: "Concurrent policy writer" },
    CreateOrchestratorTokenOutputSchema,
  );
  await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    703,
    "set_orchestrator_policy",
    {
      instructions: "Pre-existing organization policy",
      orchestrator_key_id: options.bossKeyId,
      scope_kind: "organization",
    },
    SetOrchestratorPolicyOutputSchema,
  );
  const firstInstructions: string = "Concurrent policy writer one";
  const secondInstructions: string = "Concurrent policy writer two";
  const writes: readonly [SetOrchestratorPolicyOutput, SetOrchestratorPolicyOutput] =
    await runConcurrentPolicyUpdates({
      databaseUrl: scenario.configuredAdminDatabaseUrl,
      first: async (): Promise<SetOrchestratorPolicyOutput> =>
        await callTool(
          scenario.server.mcpUrl,
          scenario.tenantA.token.secret,
          scenario.adminASession,
          704,
          "set_orchestrator_policy",
          {
            instructions: firstInstructions,
            orchestrator_key_id: options.bossKeyId,
            scope_kind: "organization",
          },
          SetOrchestratorPolicyOutputSchema,
        ),
      repositoryName: "",
      scopeKind: "organization",
      scopeOwnerId: scenario.tenantA.tenant.tenant_id,
      second: async (): Promise<SetOrchestratorPolicyOutput> =>
        await callTool(
          scenario.server.mcpUrl,
          scenario.tenantA.token.secret,
          scenario.adminASession,
          705,
          "set_orchestrator_policy",
          {
            instructions: secondInstructions,
            orchestrator_key_id: raceBoss.token.key_id,
            scope_kind: "organization",
          },
          SetOrchestratorPolicyOutputSchema,
        ),
      tenantId: scenario.tenantA.tenant.tenant_id,
    });
  expect(writes[0].policy.agent_id).toBe(options.bossAgentId);
  expect(writes[0].policy.instructions).toBe(firstInstructions);
  expect(writes[1].policy.agent_id).toBe(raceBossAgentId);
  expect(writes[1].policy.instructions).toBe(secondInstructions);
  const listed: ListOrchestratorPoliciesOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    706,
    "list_orchestrator_policies",
    { limit: 100 },
    ListOrchestratorPoliciesOutputSchema,
  );
  const organizationPolicies: OrchestratorPolicyDto[] = listed.policies.filter(
    (policy: OrchestratorPolicyDto): boolean =>
      policy.scope.scope_kind === "organization" && policy.scope.repository === null,
  );
  expect(organizationPolicies).toHaveLength(1);
  const stored: OrchestratorPolicyDto | undefined = organizationPolicies[0];
  if (stored === undefined) throw new Error("Expected the concurrent organization policy");
  const completePolicies: ReadonlySet<string> = new Set<string>([
    `${options.bossAgentId}\u0000${options.bossTokenId}\u0000${firstInstructions}`,
    `${raceBossAgentId}\u0000${raceBoss.token.token_id}\u0000${secondInstructions}`,
  ]);
  expect(completePolicies.has(policyTuple(stored))).toBe(true);
  const revoked: RevokeTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    707,
    "revoke_access_token",
    { key_id: raceBoss.token.key_id },
    RevokeTokenOutputSchema,
  );
  expect(revoked.revoked).toBe(true);
}

export async function verifyAskIdempotencyConflicts(options: {
  readonly idempotencyKey: string;
  readonly originalContent: string;
  readonly scenario: HostedTenantScenario;
  readonly worker: Worker;
}): Promise<void> {
  const conflicts: readonly Record<string, unknown>[] = [
    { content: "A conflicting orchestration question" },
    { content: options.originalContent, context: { branch: "conflicting-branch" } },
    {
      content: options.originalContent,
      thread_id: `conflicting-thread-${options.scenario.unique}`,
    },
  ];
  for (const [index, conflict] of conflicts.entries()) {
    const error: string = await callToolExpectingError(
      options.scenario.server.mcpUrl,
      options.worker.token.token.secret,
      options.worker.session,
      708 + index,
      "ask_orchestrator",
      {
        ...conflict,
        idempotency_key: options.idempotencyKey,
        sender_id: options.scenario.senderA,
      },
    );
    expect(error).toContain("was already used for a different message");
  }
  const duplicate: AskOrchestratorOutput = await callTool(
    options.scenario.server.mcpUrl,
    options.worker.token.token.secret,
    options.worker.session,
    711,
    "ask_orchestrator",
    {
      content: options.originalContent,
      idempotency_key: options.idempotencyKey,
      sender_id: options.scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(duplicate.duplicate).toBe(true);
}
