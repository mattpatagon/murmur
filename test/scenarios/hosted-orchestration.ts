import { expect } from "bun:test";

import {
  type InboxOutput,
  InboxOutputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
} from "../../src/domain/contracts.js";
import type { RevokeTokenOutput } from "../../src/hosted/contracts.js";
import {
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type ClearOrchestratorPolicyOutput,
  type CreateOrchestratorTokenOutput,
  CreateOrchestratorTokenOutputSchema,
  type GetDelegationOutput,
  GetDelegationOutputSchema,
  type GetOrchestratorOutput,
  type SetOrchestratorPolicyOutput,
} from "../../src/hosted/orchestration-contracts.js";
import {
  callTool,
  callToolExpectingError,
  initialize,
  post,
  toolNames,
} from "../support/hosted-mcp-harness.js";
import { verifyExpiredOrchestratorRotation } from "./hosted-orchestration-expiry.js";
import {
  createWorker,
  requireOrchestrator,
  resolveWorker,
  setPolicy,
  verifyAuthorityMessaging,
  verifyBoundOrchestratorLifecycle,
  verifyConcurrentAsk,
  verifyInactiveOrchestratorPruning,
  verifyOfflineOrchestratorReservation,
  verifyPersonalIdentityIsolation,
  verifyPolicyPagination,
  verifyReassignedDuplicate,
  type Worker,
} from "./hosted-orchestration-helpers.js";
import {
  verifyClearSerialization,
  verifyRevokeSerialization,
} from "./hosted-orchestration-races.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export type HostedOrchestrationResult = { readonly bossSecret: string };

export async function verifyHostedOrchestration(
  scenario: HostedTenantScenario,
): Promise<HostedOrchestrationResult> {
  const url: URL = scenario.server.mcpUrl;
  const adminToken: string = scenario.tenantA.token.secret;
  const repository: string = "mattpatagon/murmur";
  const bossAgentId: string = `hosted-boss-${scenario.unique}`;

  expect(
    await callToolExpectingError(
      url,
      adminToken,
      scenario.adminASession,
      503,
      "create_access_token",
      {
        name: "Forbidden self-claimed boss",
        role: "orchestrator",
      },
    ),
  ).toContain("invalid_value");
  expect(
    await callToolExpectingError(
      url,
      adminToken,
      scenario.adminASession,
      504,
      "create_orchestrator_token",
      {
        agent_id: scenario.senderA,
        name: "Peer collision",
      },
    ),
  ).toContain("reserved for a different authority");
  await verifyPersonalIdentityIsolation(scenario);
  await verifyExpiredOrchestratorRotation(scenario);

  const boss: CreateOrchestratorTokenOutput = await callTool(
    url,
    adminToken,
    scenario.adminASession,
    506,
    "create_orchestrator_token",
    { agent_id: bossAgentId, name: "Primary human-delegated orchestrator" },
    CreateOrchestratorTokenOutputSchema,
  );
  const bossSession: string = await initialize(url, boss.token.secret, "hosted-boss-test");
  const bossTools: readonly string[] = await toolNames(url, boss.token.secret, bossSession);
  expect(bossTools).toContain("get_delegation");
  expect(bossTools).toContain("send_message");
  expect(bossTools).not.toContain("ask_orchestrator");
  expect(bossTools).not.toContain("set_orchestrator_policy");

  const workerTools: readonly string[] = await toolNames(
    url,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
  );
  expect(workerTools).toContain("get_orchestrator");
  expect(workerTools).toContain("ask_orchestrator");
  await verifyOfflineOrchestratorReservation({
    bossAgentId,
    bossKeyId: boss.token.key_id,
    scenario,
  });
  expect(
    await callToolExpectingError(
      url,
      scenario.agentAToken.token.secret,
      scenario.agentASession,
      508,
      "register_agent",
      {
        agent_id: bossAgentId,
        display_name: "Peer takeover attempt",
      },
    ),
  ).toContain("reserved for a different authority");
  const bossRegistration: RegisterAgentOutput = await callTool(
    url,
    boss.token.secret,
    bossSession,
    509,
    "register_agent",
    { agent_id: bossAgentId, display_name: "Delegated orchestrator" },
    RegisterAgentOutputSchema,
  );
  expect(bossRegistration.agent.authority).toBe("orchestrator");
  expect(
    await callToolExpectingError(url, boss.token.secret, bossSession, 510, "register_agent", {
      agent_id: `${bossAgentId}-other`,
      display_name: "Forbidden alias",
    }),
  ).toContain("bound to a different agent ID");
  await verifyInactiveOrchestratorPruning(scenario);

  const organizationWorker: Worker = await createWorker(scenario, "organization-worker", {});
  const organizationRepoWorker: Worker = await createWorker(scenario, "organization-repo-worker", {
    repository,
  });
  const personalRepoWorker: Worker = await createWorker(scenario, "personal-repo-worker", {
    personalId: scenario.agentAToken.token.personal_id,
    repository,
  });
  const organizationPolicy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    boss.token.key_id,
    { scope_kind: "organization" },
    "Organization instructions",
  );
  const organizationRepoPolicy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    boss.token.key_id,
    { repository, scope_kind: "organization" },
    "Organization repository instructions",
  );
  const personalPolicy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    boss.token.key_id,
    { personal_id: scenario.agentAToken.token.personal_id, scope_kind: "personal" },
    "Personal instructions",
  );
  const personalRepoPolicy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    boss.token.key_id,
    {
      personal_id: scenario.agentAToken.token.personal_id,
      repository,
      scope_kind: "personal",
    },
    "Personal repository instructions",
  );
  expect(requireOrchestrator(await resolveWorker(scenario, organizationWorker)).policy_id).toBe(
    organizationPolicy.policy.policy_id,
  );
  expect(requireOrchestrator(await resolveWorker(scenario, organizationRepoWorker)).policy_id).toBe(
    organizationRepoPolicy.policy.policy_id,
  );
  const personalWorker: Worker = {
    session: scenario.agentASession,
    token: scenario.agentAToken,
  };
  expect(requireOrchestrator(await resolveWorker(scenario, personalWorker)).policy_id).toBe(
    personalPolicy.policy.policy_id,
  );
  const publicResolution: GetOrchestratorOutput = await resolveWorker(scenario, personalRepoWorker);
  expect(requireOrchestrator(publicResolution).policy_id).toBe(personalRepoPolicy.policy.policy_id);
  expect(publicResolution).not.toHaveProperty("instructions");

  await verifyPolicyPagination(scenario);
  const delegation: GetDelegationOutput = await callTool(
    url,
    boss.token.secret,
    bossSession,
    512,
    "get_delegation",
    { policy_id: personalRepoPolicy.policy.policy_id },
    GetDelegationOutputSchema,
  );
  expect(delegation.policy.instructions).toBe("Personal repository instructions");
  expect(
    await callToolExpectingError(
      url,
      personalRepoWorker.token.token.secret,
      personalRepoWorker.session,
      513,
      "get_delegation",
      {
        policy_id: personalRepoPolicy.policy.policy_id,
      },
    ),
  ).toContain("Unknown tool");

  const request: AskOrchestratorOutput = await callTool(
    url,
    personalRepoWorker.token.token.secret,
    personalRepoWorker.session,
    514,
    "ask_orchestrator",
    {
      content: "Please settle the merge-order disagreement.",
      idempotency_key: `orchestration-question-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(request.message.recipient_id).toBe(bossAgentId);
  expect(request.message.sender_authority).toBe("peer");
  expect(request.message.message_kind).toBe("orchestration_request");
  expect(request.message.orchestrator_policy_id).toBe(personalRepoPolicy.policy.policy_id);
  const bossInbox: InboxOutput = await callTool(
    url,
    boss.token.secret,
    bossSession,
    515,
    "get_messages",
    { agent_id: bossAgentId, limit: 100, unread_only: false },
    InboxOutputSchema,
  );
  expect(
    bossInbox.messages.map(
      (message: InboxOutput["messages"][number]): string => message.message_id,
    ),
  ).toContain(request.message.message_id);
  await verifyBoundOrchestratorLifecycle({
    bossAgentId,
    bossSecret: boss.token.secret,
    bossSession,
    policyId: personalRepoPolicy.policy.policy_id,
    requestMessageId: request.message.message_id,
    scenario,
  });

  const response: SendMessageOutput = await callTool(
    url,
    boss.token.secret,
    bossSession,
    516,
    "send_message",
    {
      content: "Merge the dependency branch first, then rebase.",
      idempotency_key: `boss-response-${scenario.unique}`,
      recipient_id: scenario.receiverA,
      sender_id: bossAgentId,
      thread_id: request.message.thread_id,
    },
    SendMessageOutputSchema,
  );
  expect(response.message.sender_authority).toBe("orchestrator");
  expect(response.message.message_kind).toBe("message");
  expect(response.message.orchestrator_policy_id).toBeNull();
  await verifyConcurrentAsk(scenario, personalRepoWorker);
  await verifyAuthorityMessaging({
    bossAgentId,
    bossSecret: boss.token.secret,
    bossSession,
    scenario,
  });

  const cleared: ClearOrchestratorPolicyOutput = await verifyClearSerialization({
    bossAgentId,
    policyId: personalRepoPolicy.policy.policy_id,
    repository,
    scenario,
    worker: personalRepoWorker,
  });
  expect(cleared.cleared).toBe(true);
  expect(requireOrchestrator(await resolveWorker(scenario, personalRepoWorker)).policy_id).toBe(
    organizationRepoPolicy.policy.policy_id,
  );
  const duplicate: AskOrchestratorOutput = await callTool(
    url,
    personalRepoWorker.token.token.secret,
    personalRepoWorker.session,
    518,
    "ask_orchestrator",
    {
      content: "Please settle the merge-order disagreement.",
      idempotency_key: `orchestration-question-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.message.message_id).toBe(request.message.message_id);
  expect(duplicate.message.orchestrator_policy_id).toBe(personalRepoPolicy.policy.policy_id);

  const otherBoss: CreateOrchestratorTokenOutput = await callTool(
    url,
    adminToken,
    scenario.adminASession,
    519,
    "create_orchestrator_token",
    { agent_id: `${bossAgentId}-other`, name: "Unassigned orchestrator" },
    CreateOrchestratorTokenOutputSchema,
  );
  const otherBossSession: string = await initialize(url, otherBoss.token.secret, "other-boss-test");
  expect(
    await callToolExpectingError(
      url,
      otherBoss.token.secret,
      otherBossSession,
      520,
      "get_delegation",
      {
        policy_id: organizationPolicy.policy.policy_id,
      },
    ),
  ).toContain("delegation is unavailable");
  await verifyReassignedDuplicate({
    originalBossAgentId: bossAgentId,
    originalMessageId: request.message.message_id,
    otherBossAgentId: `${bossAgentId}-other`,
    otherBossKeyId: otherBoss.token.key_id,
    repository,
    scenario,
    worker: personalRepoWorker,
  });
  expect(
    await callToolExpectingError(
      url,
      scenario.tenantB.token.secret,
      scenario.adminBSession,
      521,
      "set_orchestrator_policy",
      {
        instructions: "Cross-tenant attempt",
        orchestrator_key_id: boss.token.key_id,
        scope_kind: "organization",
      },
    ),
  ).toContain("orchestrator credential is inactive");

  const revoked: RevokeTokenOutput = await verifyRevokeSerialization({
    bossAgentId,
    bossKeyId: boss.token.key_id,
    scenario,
    worker: organizationWorker,
  });
  expect(revoked.revoked).toBe(true);
  expect(
    (
      await post(url, boss.token.secret, bossSession, {
        id: 523,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      })
    ).status,
  ).toBe(401);
  expect((await resolveWorker(scenario, organizationWorker)).orchestrator).toBeNull();
  const revokedDuplicate: AskOrchestratorOutput = await callTool(
    url,
    personalRepoWorker.token.token.secret,
    personalRepoWorker.session,
    524,
    "ask_orchestrator",
    {
      content: "Please settle the merge-order disagreement.",
      idempotency_key: `orchestration-question-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(revokedDuplicate.duplicate).toBe(true);
  expect(revokedDuplicate.message.message_id).toBe(request.message.message_id);

  const rotatedBoss: CreateOrchestratorTokenOutput = await callTool(
    url,
    adminToken,
    scenario.adminASession,
    525,
    "create_orchestrator_token",
    { agent_id: bossAgentId, name: "Rotated orchestrator" },
    CreateOrchestratorTokenOutputSchema,
  );
  const rotatedPolicy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    rotatedBoss.token.key_id,
    { repository, scope_kind: "organization" },
    "Rotated organization repository instructions",
  );
  const rotatedSession: string = await initialize(
    url,
    rotatedBoss.token.secret,
    "rotated-boss-test",
  );
  const rotatedDelegation: GetDelegationOutput = await callTool(
    url,
    rotatedBoss.token.secret,
    rotatedSession,
    526,
    "get_delegation",
    { policy_id: rotatedPolicy.policy.policy_id },
    GetDelegationOutputSchema,
  );
  expect(rotatedDelegation.policy.instructions).toBe(
    "Rotated organization repository instructions",
  );
  const rotatedDuplicate: AskOrchestratorOutput = await callTool(
    url,
    personalRepoWorker.token.token.secret,
    personalRepoWorker.session,
    527,
    "ask_orchestrator",
    {
      content: "Please settle the merge-order disagreement.",
      idempotency_key: `orchestration-question-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(rotatedDuplicate.duplicate).toBe(true);
  expect(rotatedDuplicate.message.message_id).toBe(request.message.message_id);
  return { bossSecret: rotatedBoss.token.secret };
}
