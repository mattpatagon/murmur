import { expect } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  type BroadcastMessageOutput,
  BroadcastMessageOutputSchema,
  type CloseAgentOutput,
  CloseAgentOutputSchema,
  type InboxOutput,
  InboxOutputSchema,
  type ListAgentsOutput,
  ListAgentsOutputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
} from "../../src/domain/contracts.js";
import {
  type HistoryMessageDto,
  type MessageHistoryOutput,
  MessageHistoryOutputSchema,
} from "../../src/domain/history-contracts.js";
import {
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListTokensOutput,
  ListTokensOutputSchema,
  RevokeTokenOutputSchema,
} from "../../src/hosted/contracts.js";
import {
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type CreateOrchestratorTokenOutput,
  CreateOrchestratorTokenOutputSchema,
  type EffectiveOrchestratorDto,
  type GetOrchestratorOutput,
  GetOrchestratorOutputSchema,
  type ListOrchestratorPoliciesOutput,
  ListOrchestratorPoliciesOutputSchema,
  type OrchestratorPolicyDto,
  type SetOrchestratorPolicyOutput,
  SetOrchestratorPolicyOutputSchema,
} from "../../src/hosted/orchestration-contracts.js";
import { callTool, callToolExpectingError, initialize } from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export type Worker = { readonly session: string; readonly token: IssuedTokenOutput };
export function requireOrchestrator(output: GetOrchestratorOutput): EffectiveOrchestratorDto {
  if (output.orchestrator === null) throw new Error("Expected an effective orchestrator");
  return output.orchestrator;
}

export async function createWorker(
  scenario: HostedTenantScenario,
  name: string,
  options: {
    readonly machine?: string;
    readonly personalId?: string;
    readonly repository?: string;
  },
): Promise<Worker> {
  const token: IssuedTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    500,
    "create_access_token",
    {
      name,
      ...(options.machine === undefined ? {} : { machine: options.machine }),
      ...(options.personalId === undefined ? {} : { personal_id: options.personalId }),
      ...(options.repository === undefined ? {} : { repository: options.repository }),
      role: "agent",
    },
    IssuedTokenOutputSchema,
  );
  return {
    session: await initialize(scenario.server.mcpUrl, token.token.secret, name),
    token,
  };
}

export async function resolveWorker(
  scenario: HostedTenantScenario,
  worker: Worker,
): Promise<GetOrchestratorOutput> {
  return await callTool(
    scenario.server.mcpUrl,
    worker.token.token.secret,
    worker.session,
    501,
    "get_orchestrator",
    {},
    GetOrchestratorOutputSchema,
  );
}

export async function setPolicy(
  scenario: HostedTenantScenario,
  keyId: string,
  scope: Record<string, unknown>,
  instructions: string,
): Promise<SetOrchestratorPolicyOutput> {
  return await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    502,
    "set_orchestrator_policy",
    { ...scope, instructions, orchestrator_key_id: keyId },
    SetOrchestratorPolicyOutputSchema,
  );
}

export async function verifyOfflineOrchestratorReservation(options: {
  readonly bossAgentId: string;
  readonly bossKeyId: string;
  readonly scenario: HostedTenantScenario;
}): Promise<void> {
  const scenario: HostedTenantScenario = options.scenario;
  const agents: ListAgentsOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    503,
    "list_agents",
    { state: "all" },
    ListAgentsOutputSchema,
  );
  const reserved: ListAgentsOutput["agents"][number] | undefined = agents.agents.find(
    (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === options.bossAgentId,
  );
  if (reserved === undefined) throw new Error("Expected the reserved orchestrator identity");
  expect(reserved.authority).toBe("orchestrator");
  expect(reserved.state).toBe("inactive");
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.agentAToken.token.secret,
      scenario.agentASession,
      504,
      "close_agent",
      {
        agent_id: options.bossAgentId,
        expected_generation: reserved.generation,
        reason: "manual",
      },
    ),
  ).toContain("reserved for a different authority");
  const policy: SetOrchestratorPolicyOutput = await setPolicy(
    scenario,
    options.bossKeyId,
    { scope_kind: "organization" },
    "Offline orchestrator instructions",
  );
  const request: AskOrchestratorOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    505,
    "ask_orchestrator",
    {
      content: "Route this while the orchestrator is offline.",
      idempotency_key: `offline-orchestrator-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(request.message.recipient_id).toBe(options.bossAgentId);
  expect(request.message.orchestrator_policy_id).toBe(policy.policy.policy_id);
}

export async function verifyBoundOrchestratorLifecycle(options: {
  readonly bossAgentId: string;
  readonly bossSecret: string;
  readonly bossSession: string;
  readonly policyId: string;
  readonly requestMessageId: string;
  readonly scenario: HostedTenantScenario;
}): Promise<void> {
  const scenario: HostedTenantScenario = options.scenario;
  const forbidden: readonly {
    readonly argumentsValue: Record<string, unknown>;
    readonly name: string;
  }[] = [
    {
      argumentsValue: { agent_id: scenario.senderA, expected_generation: 1, reason: "manual" },
      name: "close_agent",
    },
    {
      argumentsValue: {
        after_sequence: 0,
        agent_id: scenario.senderA,
        generation: 1,
        limit: 100,
        unread_only: false,
      },
      name: "get_message_history",
    },
    {
      argumentsValue: {
        actor_id: scenario.senderA,
        content: "Forbidden delegated identity",
        kind: "ownership",
      },
      name: "post_notice",
    },
  ];
  for (const invocation of forbidden) {
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        options.bossSecret,
        options.bossSession,
        506,
        invocation.name,
        invocation.argumentsValue,
      ),
    ).toContain("bound to a different agent ID");
  }
  const closed: CloseAgentOutput = await callTool(
    scenario.server.mcpUrl,
    options.bossSecret,
    options.bossSession,
    507,
    "close_agent",
    { agent_id: options.bossAgentId, expected_generation: 1, reason: "manual" },
    CloseAgentOutputSchema,
  );
  expect(closed.agent.state).toBe("closed");
  const reopened: RegisterAgentOutput = await callTool(
    scenario.server.mcpUrl,
    options.bossSecret,
    options.bossSession,
    508,
    "register_agent",
    { agent_id: options.bossAgentId },
    RegisterAgentOutputSchema,
  );
  expect(reopened.agent.authority).toBe("orchestrator");
  expect(reopened.agent.generation).toBe(2);
  const history: MessageHistoryOutput = await callTool(
    scenario.server.mcpUrl,
    options.bossSecret,
    options.bossSession,
    509,
    "get_message_history",
    {
      after_sequence: 0,
      agent_id: options.bossAgentId,
      generation: 1,
      limit: 100,
      unread_only: false,
    },
    MessageHistoryOutputSchema,
  );
  const request: HistoryMessageDto | undefined = history.messages.find(
    (message: HistoryMessageDto): boolean => message.message_id === options.requestMessageId,
  );
  if (request === undefined) throw new Error("Expected the routed request in retained history");
  expect(request.sender_authority).toBe("peer");
  expect(request.message_kind).toBe("orchestration_request");
  expect(request.orchestrator_policy_id).toBe(options.policyId);
}

export async function verifyReassignedDuplicate(options: {
  readonly originalBossAgentId: string;
  readonly originalMessageId: string;
  readonly otherBossAgentId: string;
  readonly otherBossKeyId: string;
  readonly repository: string;
  readonly scenario: HostedTenantScenario;
  readonly worker: Worker;
}): Promise<void> {
  const scenario: HostedTenantScenario = options.scenario;
  await setPolicy(
    scenario,
    options.otherBossKeyId,
    {
      personal_id: scenario.agentAToken.token.personal_id,
      repository: options.repository,
      scope_kind: "personal",
    },
    "Reassigned personal repository instructions",
  );
  expect(requireOrchestrator(await resolveWorker(scenario, options.worker)).agent_id).toBe(
    options.otherBossAgentId,
  );
  const duplicate: AskOrchestratorOutput = await callTool(
    scenario.server.mcpUrl,
    options.worker.token.token.secret,
    options.worker.session,
    528,
    "ask_orchestrator",
    {
      content: "Please settle the merge-order disagreement.",
      idempotency_key: `orchestration-question-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    AskOrchestratorOutputSchema,
  );
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.message.message_id).toBe(options.originalMessageId);
  expect(duplicate.orchestrator.agent_id).toBe(options.originalBossAgentId);
}

export async function verifyConcurrentAsk(
  scenario: HostedTenantScenario,
  worker: Worker,
): Promise<void> {
  const invoke: (requestId: number) => Promise<AskOrchestratorOutput> = async (
    requestId: number,
  ): Promise<AskOrchestratorOutput> =>
    await callTool(
      scenario.server.mcpUrl,
      worker.token.token.secret,
      worker.session,
      requestId,
      "ask_orchestrator",
      {
        content: "Resolve this concurrent retry exactly once.",
        idempotency_key: `orchestration-concurrent-${scenario.unique}`,
        sender_id: scenario.senderA,
      },
      AskOrchestratorOutputSchema,
    );
  const [first, second]: [AskOrchestratorOutput, AskOrchestratorOutput] = await Promise.all([
    invoke(529),
    invoke(530),
  ]);
  expect(first.message.message_id).toBe(second.message.message_id);
  expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
}

export async function verifyPolicyPagination(scenario: HostedTenantScenario): Promise<void> {
  const first: ListOrchestratorPoliciesOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    511,
    "list_orchestrator_policies",
    { limit: 2 },
    ListOrchestratorPoliciesOutputSchema,
  );
  if (first.next_cursor === null) throw new Error("Expected another policy page");
  const second: ListOrchestratorPoliciesOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    512,
    "list_orchestrator_policies",
    { cursor: first.next_cursor, limit: 2 },
    ListOrchestratorPoliciesOutputSchema,
  );
  expect(second.next_cursor).toBeNull();
  const policies: OrchestratorPolicyDto[] = [...first.policies, ...second.policies];
  expect(policies).toHaveLength(4);
  expect(
    new Set(policies.map((policy: OrchestratorPolicyDto): string => policy.policy_id)).size,
  ).toBe(4);
  expect(policies.map((policy: OrchestratorPolicyDto): string => policy.instructions)).toContain(
    "Personal repository instructions",
  );
}

export async function verifyInactiveOrchestratorPruning(
  scenario: HostedTenantScenario,
): Promise<void> {
  const orphan: CreateOrchestratorTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    543,
    "create_orchestrator_token",
    {
      agent_id: `orphaned-orchestrator-${scenario.unique}`,
      name: "Unreferenced revoked orchestrator",
    },
    CreateOrchestratorTokenOutputSchema,
  );
  await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    544,
    "revoke_access_token",
    { key_id: orphan.token.key_id },
    RevokeTokenOutputSchema,
  );
  await createWorker(scenario, "orchestrator-prune-trigger", {});
  const listed: ListTokensOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    545,
    "list_access_tokens",
    { limit: 500 },
    ListTokensOutputSchema,
  );
  expect(
    listed.tokens.some(
      (token: ListTokensOutput["tokens"][number]): boolean => token.key_id === orphan.token.key_id,
    ),
  ).toBe(false);
}

export async function verifyAuthorityMessaging(options: {
  readonly bossAgentId: string;
  readonly bossSecret: string;
  readonly bossSession: string;
  readonly scenario: HostedTenantScenario;
}): Promise<void> {
  const scenario: HostedTenantScenario = options.scenario;
  const toolNames: readonly ("broadcast_message" | "send_message")[] = [
    "send_message",
    "broadcast_message",
  ];
  for (const toolName of toolNames) {
    const recipient: Record<string, unknown> =
      toolName === "send_message" ? { recipient_id: scenario.receiverA } : {};
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.agentAToken.token.secret,
        scenario.agentASession,
        toolName === "send_message" ? 531 : 532,
        toolName,
        {
          ...recipient,
          content: "Peer authority spoof attempt",
          sender_id: options.bossAgentId,
        },
      ),
    ).toContain("cannot act as this agent");
  }
  const broadcast: BroadcastMessageOutput = await callTool(
    scenario.server.mcpUrl,
    options.bossSecret,
    options.bossSession,
    533,
    "broadcast_message",
    {
      content: "Verified orchestrator broadcast",
      idempotency_key: `orchestrator-broadcast-${scenario.unique}`,
      sender_id: options.bossAgentId,
    },
    BroadcastMessageOutputSchema,
  );
  expect(broadcast.recipient_count).toBeGreaterThan(0);
  const recipientInbox: InboxOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    534,
    "get_messages",
    { agent_id: scenario.receiverA, limit: 100, unread_only: false },
    InboxOutputSchema,
  );
  expect(
    recipientInbox.messages.some(
      (message: InboxOutput["messages"][number]): boolean =>
        message.content === "Verified orchestrator broadcast" &&
        message.sender_authority === "orchestrator",
    ),
  ).toBe(true);
}

export async function verifyPersonalIdentityIsolation(
  scenario: HostedTenantScenario,
): Promise<void> {
  const personalIds: readonly string[] = [randomUUID(), scenario.agentBToken.token.personal_id];
  for (const [index, personalId] of personalIds.entries()) {
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.tenantA.token.secret,
        scenario.adminASession,
        535 + index * 2,
        "create_access_token",
        {
          name: "Invalid personal identity reuse",
          personal_id: personalId,
          role: "agent",
        },
      ),
    ).toContain("personal identity is unavailable");
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.tenantA.token.secret,
        scenario.adminASession,
        536 + index * 2,
        "create_orchestrator_token",
        {
          agent_id: `invalid-personal-boss-${scenario.unique}-${String(index)}`,
          name: "Invalid orchestrator identity reuse",
          personal_id: personalId,
        },
      ),
    ).toContain("personal identity is unavailable");
  }
}
