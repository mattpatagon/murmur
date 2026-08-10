import { expect } from "bun:test";

import {
  type BroadcastMessageOutput,
  BroadcastMessageOutputSchema,
  type InboxOutput,
  InboxOutputSchema,
  type ListAgentsOutput,
  ListAgentsOutputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
} from "../../src/domain/contracts.js";
import {
  callTool,
  callToolExpectingError,
  headers,
  nextResourceUpdate,
  subscribeInbox,
} from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyHostedTenantMessaging(scenario: HostedTenantScenario): Promise<void> {
  const receiverAUri: string = `murmur://inbox/${scenario.receiverA}`;
  const receiverBUri: string = `murmur://inbox/${scenario.receiverB}`;
  await subscribeInbox(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    408,
    receiverAUri,
  );
  await subscribeInbox(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    409,
    receiverBUri,
  );
  const streamAAbortController: AbortController = new AbortController();
  const streamBAbortController: AbortController = new AbortController();
  const streamA: Response = await fetch(scenario.server.mcpUrl, {
    headers: headers(scenario.agentAToken.token.secret, scenario.agentASession),
    signal: streamAAbortController.signal,
  });
  const streamB: Response = await fetch(scenario.server.mcpUrl, {
    headers: headers(scenario.agentBToken.token.secret, scenario.agentBSession),
    signal: streamBAbortController.signal,
  });
  expect(streamA.status).toBe(200);
  expect(streamB.status).toBe(200);
  const notificationA: Promise<string> = nextResourceUpdate(streamA);
  const notificationB: Promise<string> = nextResourceUpdate(streamB);

  const idempotencyKey: string = `same-key-${scenario.unique}`;
  const sentA: SendMessageOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    20,
    "send_message",
    {
      content: "tenant A message",
      idempotency_key: idempotencyKey,
      recipient_id: scenario.receiverA,
      sender_id: scenario.senderA,
    },
    SendMessageOutputSchema,
  );
  expect(
    await Promise.race([
      notificationA,
      Bun.sleep(3_000).then((): never => {
        throw new Error("Tenant A inbox notification timed out");
      }),
    ]),
  ).toBe(receiverAUri);
  const tenantBStayedQuiet: boolean = await Promise.race([
    notificationB.then((): boolean => false),
    Bun.sleep(250).then((): boolean => true),
  ]);
  expect(tenantBStayedQuiet).toBe(true);
  const sentB: SendMessageOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    21,
    "send_message",
    {
      content: "tenant B message",
      idempotency_key: idempotencyKey,
      recipient_id: scenario.receiverB,
      sender_id: scenario.senderB,
    },
    SendMessageOutputSchema,
  );
  expect(
    await Promise.race([
      notificationB,
      Bun.sleep(3_000).then((): never => {
        throw new Error("Tenant B inbox notification timed out");
      }),
    ]),
  ).toBe(receiverBUri);
  streamAAbortController.abort();
  streamBAbortController.abort();
  expect(sentA.message.content).toBe("tenant A message");
  expect(sentB.message.content).toBe("tenant B message");
  expect(sentA.message.sequence).toBe(1);
  expect(sentB.message.sequence).toBe(1);

  const broadcastA: BroadcastMessageOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    211,
    "broadcast_message",
    {
      audience: {},
      content: "tenant A organization broadcast",
      idempotency_key: `tenant-a-broadcast-${scenario.unique}`,
      sender_id: scenario.senderA,
    },
    BroadcastMessageOutputSchema,
  );
  expect(broadcastA.recipient_count).toBe(1);

  const agentsA: ListAgentsOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    22,
    "list_agents",
    {},
    ListAgentsOutputSchema,
  );
  expect(
    agentsA.agents.some(
      (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === scenario.senderA,
    ),
  ).toBe(true);
  expect(
    agentsA.agents.some(
      (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === scenario.receiverB,
    ),
  ).toBe(false);
  const inboxA: InboxOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    23,
    "get_messages",
    { agent_id: scenario.receiverA, limit: 100, unread_only: false },
    InboxOutputSchema,
  );
  expect(
    inboxA.messages.map((message: InboxOutput["messages"][number]): string => message.content),
  ).toEqual(["tenant A message", "tenant A organization broadcast"]);
  expect(
    inboxA.messages.map((message: InboxOutput["messages"][number]): number => message.sequence),
  ).toEqual([1, 2]);
  const inboxB: InboxOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    231,
    "get_messages",
    { agent_id: scenario.receiverB, limit: 100, unread_only: false },
    InboxOutputSchema,
  );
  expect(
    inboxB.messages.map((message: InboxOutput["messages"][number]): string => message.content),
  ).toEqual(["tenant B message"]);
  const crossReadError: string = await callToolExpectingError(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    24,
    "get_messages",
    { agent_id: scenario.receiverA, limit: 100, unread_only: false },
  );
  expect(crossReadError).toContain("Unknown agent");
  expect(crossReadError).not.toContain("tenant A message");

  const markedA: MarkMessagesReadOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    241,
    "mark_messages_read",
    {
      agent_id: scenario.receiverA,
      message_ids: inboxA.messages.map(
        (message: InboxOutput["messages"][number]): string => message.message_id,
      ),
    },
    MarkMessagesReadOutputSchema,
  );
  expect(markedA.updated).toBe(2);
}
