import { expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import {
  type CloseAgentOutput,
  CloseAgentOutputSchema,
  type EndSessionOutput,
  EndSessionOutputSchema,
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
  AgentGeneration,
  MAX_RETAINED_SESSIONS_PER_AGENT,
  SessionKey,
} from "../../src/domain/lifecycle-values.js";
import type { Agent, RegisterAgentResult } from "../../src/domain/models.js";
import {
  type ListNoticesOutput,
  ListNoticesOutputSchema,
  type NoticeMutationOutput,
  NoticeMutationOutputSchema,
} from "../../src/domain/notice-contracts.js";
import { AgentId, DisplayName, Instant, TenantId } from "../../src/domain/value-objects.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import type { MessageStore } from "../../src/storage/message-store.js";
import { PostgresMessageStore } from "../../src/storage/postgres-message-store.js";
import { MutableClock } from "../support/store-fixture.js";
import {
  callTool,
  callToolExpectingError,
  databaseUrl,
  testTlsConfiguration,
} from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

async function registerDirect(
  store: MessageStore,
  agentId: string,
  repository: string,
  sessionKey: string,
): Promise<RegisterAgentResult> {
  return await store.registerAgent({
    agentId: AgentId.parse(agentId),
    displayName: DisplayName.parse(agentId),
    metadata: { repository },
    sessionKey: SessionKey.parse(sessionKey),
  });
}

async function verifyMcpLifecycle(scenario: HostedTenantScenario): Promise<void> {
  const token: string = scenario.agentAToken.token.secret;
  const paneA: RegisterAgentOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    501,
    "register_agent",
    { agent_id: scenario.senderA, session_key: "lifecycle-pane-a" },
    RegisterAgentOutputSchema,
  );
  expect(paneA.agent.live_session_count).toBe(2);
  const paneB: RegisterAgentOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    502,
    "register_agent",
    { agent_id: scenario.senderA, session_key: "lifecycle-pane-b" },
    RegisterAgentOutputSchema,
  );
  expect(paneB.agent.live_session_count).toBe(3);
  const ended: EndSessionOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    503,
    "end_session",
    {
      agent_id: scenario.senderA,
      end_default_session: true,
      expected_generation: 1,
      reason: "stop",
      session_key: "lifecycle-pane-a",
    },
    EndSessionOutputSchema,
  );
  expect(ended).toEqual({ ended: 2, generation: 1 });
  const unknownEnd: EndSessionOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    504,
    "end_session",
    { agent_id: `unknown-${scenario.unique}`, expected_generation: 1, reason: "session_end" },
    EndSessionOutputSchema,
  );
  expect(unknownEnd).toEqual({ ended: 0, generation: null });
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      token,
      scenario.agentASession,
      505,
      "end_session",
      { agent_id: scenario.senderA, expected_generation: 2, reason: "stop" },
    ),
  ).toContain("changed generation");
  const active: ListAgentsOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    506,
    "list_agents",
    { state: "active" },
    ListAgentsOutputSchema,
  );
  expect(
    active.agents.some(
      (agent: ListAgentsOutput["agents"][number]): boolean =>
        agent.agent_id === scenario.senderA && agent.live_session_count === 1,
    ),
  ).toBe(true);
}

async function verifyMcpNotices(scenario: HostedTenantScenario): Promise<void> {
  const token: string = scenario.agentAToken.token.secret;
  const ownership: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    510,
    "post_notice",
    {
      actor_id: scenario.senderA,
      content: "Lifecycle migration ownership",
      idempotency_key: `ownership-${scenario.unique}`,
      kind: "ownership",
      session_key: "lifecycle-pane-b",
    },
    NoticeMutationOutputSchema,
  );
  const ownershipRetry: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    511,
    "post_notice",
    {
      actor_id: scenario.senderA,
      content: "Lifecycle migration ownership",
      idempotency_key: `ownership-${scenario.unique}`,
      kind: "ownership",
      session_key: "lifecycle-pane-b",
    },
    NoticeMutationOutputSchema,
  );
  expect(ownershipRetry.duplicate).toBe(true);
  expect(ownershipRetry.notice.notice_id).toBe(ownership.notice.notice_id);
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      token,
      scenario.agentASession,
      512,
      "post_notice",
      {
        actor_id: scenario.senderA,
        content: "Conflicting ownership",
        idempotency_key: `ownership-${scenario.unique}`,
        kind: "ownership",
      },
    ),
  ).toContain("already used");
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      token,
      scenario.agentASession,
      513,
      "withdraw_notice",
      {
        actor_id: scenario.receiverA,
        notice_id: ownership.notice.notice_id,
        resolution_note: "Not the creator",
      },
    ),
  ).toContain("creating agent identity");
  const withdrawn: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    514,
    "withdraw_notice",
    {
      actor_id: scenario.senderA,
      notice_id: ownership.notice.notice_id,
      resolution_note: "Ownership transferred",
      session_key: "lifecycle-pane-b",
    },
    NoticeMutationOutputSchema,
  );
  expect(withdrawn.notice.state).toBe("withdrawn");
  const withdrawnRetry: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    515,
    "withdraw_notice",
    {
      actor_id: scenario.senderA,
      notice_id: ownership.notice.notice_id,
      resolution_note: "Ownership transferred",
    },
    NoticeMutationOutputSchema,
  );
  expect(withdrawnRetry.duplicate).toBe(true);
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      token,
      scenario.agentASession,
      521,
      "withdraw_notice",
      {
        actor_id: scenario.receiverA,
        notice_id: ownership.notice.notice_id,
        resolution_note: "Still not the creator",
      },
    ),
  ).toContain("creating agent identity");

  const blocker: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    516,
    "post_notice",
    {
      actor_id: scenario.senderA,
      branch: "feature/lifecycle",
      content: "PostgreSQL gate is blocked",
      expires_in_hours: 1,
      kind: "blocker",
    },
    NoticeMutationOutputSchema,
  );
  const open: ListNoticesOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    517,
    "list_notices",
    { actor_id: scenario.receiverA, kind: "blocker", state: "open" },
    ListNoticesOutputSchema,
  );
  expect(
    open.notices.map((notice: ListNoticesOutput["notices"][number]): string => notice.notice_id),
  ).toContain(blocker.notice.notice_id);
  const resolved: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    518,
    "resolve_notice",
    {
      actor_id: scenario.receiverA,
      notice_id: blocker.notice.notice_id,
      resolution_note: "PostgreSQL gate passed",
    },
    NoticeMutationOutputSchema,
  );
  expect(resolved.notice.resolved_by_id).toBe(scenario.receiverA);
  const resolvedRetry: NoticeMutationOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    519,
    "resolve_notice",
    {
      actor_id: scenario.receiverA,
      notice_id: blocker.notice.notice_id,
      resolution_note: "PostgreSQL gate passed",
    },
    NoticeMutationOutputSchema,
  );
  expect(resolvedRetry.duplicate).toBe(true);
  const terminal: ListNoticesOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    520,
    "list_notices",
    { actor_id: scenario.senderA, state: "all" },
    ListNoticesOutputSchema,
  );
  expect(terminal.notices).toHaveLength(2);
}

async function verifyClosureAndHistory(scenario: HostedTenantScenario): Promise<void> {
  const token: string = scenario.agentAToken.token.secret;
  const closed: CloseAgentOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    530,
    "close_agent",
    { agent_id: scenario.receiverA, expected_generation: 1, reason: "completed" },
    CloseAgentOutputSchema,
  );
  expect(closed.agent.state).toBe("closed");
  const closedAgain: CloseAgentOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    531,
    "close_agent",
    { agent_id: scenario.receiverA, expected_generation: 1, reason: "completed" },
    CloseAgentOutputSchema,
  );
  expect(closedAgain.already_closed).toBe(true);
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      token,
      scenario.agentASession,
      532,
      "send_message",
      {
        content: "must not deliver",
        recipient_id: scenario.receiverA,
        sender_id: scenario.senderA,
      },
    ),
  ).toContain("is closed");
  const history: MessageHistoryOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    533,
    "get_message_history",
    {
      after_sequence: 0,
      agent_id: scenario.receiverA,
      generation: 1,
      limit: 100,
      unread_only: false,
    },
    MessageHistoryOutputSchema,
  );
  expect(history.messages.length).toBeGreaterThan(0);
  expect(
    history.messages.every(
      (message: HistoryMessageDto): boolean => message.recipient_generation === 1,
    ),
  ).toBe(true);
  const reopened: RegisterAgentOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    534,
    "register_agent",
    { agent_id: scenario.receiverA, session_key: "receiver-generation-two" },
    RegisterAgentOutputSchema,
  );
  expect(reopened.reopened).toBe(true);
  expect(reopened.agent.generation).toBe(2);
  const current: InboxOutput = await callTool(
    scenario.server.mcpUrl,
    token,
    scenario.agentASession,
    535,
    "get_messages",
    { agent_id: scenario.receiverA, limit: 100, unread_only: false },
    InboxOutputSchema,
  );
  expect(current.messages).toHaveLength(0);
}

async function verifyDirectPostgresBranches(scenario: HostedTenantScenario): Promise<void> {
  const configuredDatabaseUrl: string | undefined = databaseUrl;
  if (configuredDatabaseUrl === undefined) throw new Error("PostgreSQL URL is required");
  const clock: MutableClock = new MutableClock(Instant.parse(new Date().toISOString()));
  const root: PostgresMessageStore = await PostgresMessageStore.connect(
    configuredDatabaseUrl,
    testTlsConfiguration,
    clock,
  );
  const store: MessageStore = root.scope(TenantId.parse(scenario.tenantA.tenant.tenant_id));
  const agentId: string = `lifecycle-direct-${scenario.unique}`;
  try {
    const first: RegisterAgentResult = await registerDirect(
      store,
      agentId,
      "owner/repo-a",
      "pane-a",
    );
    expect(first.agent.generation.value).toBe(1);
    const divergent: RegisterAgentResult = await registerDirect(
      store,
      agentId,
      "owner/repo-b",
      "pane-b",
    );
    expect(divergent.repositoryDiverged).toBe(true);
    expect(divergent.agent.metadata["repository"]).toBe("owner/repo-a");
    clock.set(clock.now().addMinutes(60));
    const switched: RegisterAgentResult = await registerDirect(
      store,
      agentId,
      "owner/repo-b",
      "pane-c",
    );
    expect(switched.agent.generation.value).toBe(2);
    for (let index: number = 1; index <= 9; index += 1) {
      await registerDirect(store, agentId, "owner/repo-b", `cap-${index}`);
    }
    for (let index: number = 10; index <= 100; index += 1) {
      await registerDirect(store, agentId, "owner/repo-b", `cap-${index}`);
    }
    const cappedAgent: Agent | null = await store.getAgent(AgentId.parse(agentId));
    if (cappedAgent === null) throw new Error("Expected capped lifecycle agent");
    expect(cappedAgent.liveSessionCount).toBe(8);
    const adminUrl: string | undefined = scenario.configuredAdminDatabaseUrl;
    if (adminUrl === undefined) throw new Error("PostgreSQL admin URL is required");
    const admin: Sql = postgres(adminUrl, {
      max: 1,
      ssl: postgresSslOptions(adminUrl, testTlsConfiguration),
    });
    try {
      const rows: { readonly count: number }[] = await admin<{ readonly count: number }[]>`
        SELECT COUNT(*)::int AS count FROM murmur.agent_sessions
        WHERE tenant_id = ${scenario.tenantA.tenant.tenant_id}::uuid
          AND agent_id = ${agentId}
      `;
      const row: { readonly count: number } | undefined = rows[0];
      if (row === undefined) throw new Error("Expected retained session count");
      expect(row.count).toBe(MAX_RETAINED_SESSIONS_PER_AGENT);
    } finally {
      await admin.end({ timeout: 5 });
    }
    await expect(
      store.endSession({
        agentId: AgentId.parse(agentId),
        endDefaultSession: false,
        endReason: "stop",
        expectedGeneration: AgentGeneration.parse(1),
        sessionKey: SessionKey.parse("cap-9"),
      }),
    ).rejects.toThrow("changed generation");
    await store.closeAgent({
      agentId: AgentId.parse(agentId),
      closeReason: "manual",
      expectedGeneration: AgentGeneration.parse(2),
    });
    const explicitReturn: RegisterAgentResult = await registerDirect(
      store,
      agentId,
      "owner/repo-b",
      "explicit-return",
    );
    expect(explicitReturn.agent.generation.value).toBe(3);
    clock.set(clock.now().addDays(30));
    await store.pruneExpired(clock.now());
    const dormantReturn: RegisterAgentResult = await registerDirect(
      store,
      agentId,
      "owner/repo-b",
      "dormant-return",
    );
    expect(dormantReturn.agent.generation.value).toBe(3);
  } finally {
    await root.close();
  }
}

export async function verifyHostedAgentLifecycleProtocol(
  scenario: HostedTenantScenario,
): Promise<void> {
  await verifyMcpLifecycle(scenario);
  await verifyMcpNotices(scenario);
  await verifyClosureAndHistory(scenario);
}

export async function verifyHostedAgentLifecycleStorage(
  scenario: HostedTenantScenario,
): Promise<void> {
  await verifyDirectPostgresBranches(scenario);
}
