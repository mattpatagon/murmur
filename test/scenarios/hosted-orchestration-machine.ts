import { expect } from "bun:test";

import { type RegisterAgentOutput, RegisterAgentOutputSchema } from "../../src/domain/contracts.js";
import {
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type ClearOrchestratorPolicyOutput,
  ClearOrchestratorPolicyOutputSchema,
  type GetOrchestratorOutput,
  type SetOrchestratorPolicyOutput,
} from "../../src/hosted/orchestration-contracts.js";
import { type SetupGuideOutput, SetupGuideOutputSchema } from "../../src/mcp/murmur-setup-guide.js";
import { callTool } from "../support/hosted-mcp-harness.js";
import {
  createWorker,
  requireOrchestrator,
  resolveWorker,
  setPolicy,
  type Worker,
} from "./hosted-orchestration-helpers.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyMachineScopedRouting(options: {
  readonly bossAgentId: string;
  readonly bossKeyId: string;
  readonly scenario: HostedTenantScenario;
}): Promise<void> {
  const scenario: HostedTenantScenario = options.scenario;
  const machine: string = `build-${scenario.unique}`;
  const repository: string = "mattpatagon/murmur";
  const workerId: string = `machine-worker-${scenario.unique}`;
  const worker: Worker = await createWorker(scenario, "machine-bound-worker", {
    machine,
    repository,
  });
  expect(worker.token.token.machine).toBe(machine);
  expect(worker.token.token.repository).toBe(repository);
  const guide: SetupGuideOutput = await callTool(
    scenario.server.mcpUrl,
    worker.token.token.secret,
    worker.session,
    5070,
    "get_setup_guide",
    { topic: "orchestration" },
    SetupGuideOutputSchema,
  );
  expect(guide.available_tools).toContain("get_setup_guide");
  expect(guide.available_tools).toContain("get_orchestrator");
  expect(guide.available_tools).not.toContain("set_orchestrator_policy");
  expect(guide.sections).toHaveLength(1);
  const guideSection: SetupGuideOutput["sections"][number] | undefined = guide.sections[0];
  if (guideSection === undefined) throw new Error("Expected orchestration setup guide");
  expect(guideSection.instructions).toContain("personal+machine+repository");
  expect(guideSection.instructions).toContain("mint_tenant_admin_token");
  const policy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    options.bossKeyId,
    { machine, repository, scope_kind: "organization" },
    "Machine and repository instructions",
  );
  const registration: RegisterAgentOutput = await callTool(
    scenario.server.mcpUrl,
    worker.token.token.secret,
    worker.session,
    5071,
    "register_agent",
    {
      agent_id: workerId,
      display_name: "Machine-bound worker",
      metadata: { machine: "spoofed-machine", repository: "attacker/example" },
    },
    RegisterAgentOutputSchema,
  );
  expect(registration.agent.agent_id).toBe(workerId);
  const resolved: GetOrchestratorOutput = await resolveWorker(scenario, worker);
  expect(requireOrchestrator(resolved).policy_id).toBe(policy.policy.policy_id);
  expect(requireOrchestrator(resolved).scope).toMatchObject({ machine, repository });
  const request: AskOrchestratorOutput = await callTool(
    scenario.server.mcpUrl,
    worker.token.token.secret,
    worker.session,
    5072,
    "ask_orchestrator",
    {
      content: "Route using authenticated bindings, not this descriptive context.",
      context: { branch: "attacker", client: "test", repository: "attacker/example" },
      idempotency_key: `machine-route-${scenario.unique}`,
      sender_id: workerId,
    },
    AskOrchestratorOutputSchema,
  );
  expect(request.message.recipient_id).toBe(options.bossAgentId);
  expect(request.message.orchestrator_policy_id).toBe(policy.policy.policy_id);
  const cleared: ClearOrchestratorPolicyOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    5073,
    "clear_orchestrator_policy",
    { machine, repository, scope_kind: "organization" },
    ClearOrchestratorPolicyOutputSchema,
  );
  expect(cleared.cleared).toBe(true);
  const fallback: GetOrchestratorOutput = await resolveWorker(scenario, worker);
  expect(requireOrchestrator(fallback).scope.repository).toBe(repository);
  expect(requireOrchestrator(fallback).scope).not.toHaveProperty("machine");
}
