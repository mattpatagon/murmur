import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  ReadResourceResult,
  ResourceUpdatedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  type BroadcastMessageOutput,
  BroadcastMessageOutputSchema,
  type InboxOutput,
  InboxOutputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
} from "../src/domain/contracts.js";
import {
  bunInstallFromCurrentExecutable,
  type ClientHarness,
  callValidated,
  childEnvironment,
  connectClient,
  connectClientWithEnvironment,
  connectGenericClient,
  notificationTimeout,
  type ResourceContent,
} from "./support/mcp-client-harness.js";

test("launcher resolves Bun when the host PATH omits Bun", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-mcp-"));
  const databasePath: string = join(directory, "messages.db");
  const environment: Record<string, string> = childEnvironment(databasePath);
  environment["BUN_INSTALL"] = bunInstallFromCurrentExecutable();
  environment["PATH"] = "/usr/bin:/bin";
  const harness: ClientHarness = await connectClientWithEnvironment(
    "minimal-path-host",
    environment,
  );
  try {
    const toolsResult: Awaited<ReturnType<Client["listTools"]>> = await harness.client.listTools();
    const hasRegisterTool: boolean = toolsResult.tools.some(
      (tool: (typeof toolsResult.tools)[number]): boolean => tool.name === "register_agent",
    );
    expect(hasRegisterTool).toBe(true);
  } finally {
    await Promise.allSettled([harness.client.close()]);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("two MCP processes exchange a durable message and push an inbox update", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-mcp-"));
  const databasePath: string = join(directory, "messages.db");
  const sender: ClientHarness = await connectClient("sender-host", databasePath);
  const receiver: ClientHarness = await connectClient("receiver-host", databasePath);
  try {
    const toolsResult: Awaited<ReturnType<Client["listTools"]>> = await sender.client.listTools();
    const hasSendTool: boolean = toolsResult.tools.some(
      (tool: (typeof toolsResult.tools)[number]): boolean => tool.name === "send_message",
    );
    expect(hasSendTool).toBe(true);

    const senderRegistration: RegisterAgentOutput = await callValidated(
      sender.client,
      "register_agent",
      { agent_id: "agent-a", display_name: "Agent A" },
      RegisterAgentOutputSchema,
    );
    const receiverRegistration: RegisterAgentOutput = await callValidated(
      receiver.client,
      "register_agent",
      { agent_id: "agent-b", display_name: "Agent B" },
      RegisterAgentOutputSchema,
    );
    expect(senderRegistration.agent.agent_id).toBe("agent-a");
    expect(receiverRegistration.agent.agent_id).toBe("agent-b");

    const inboxUri: string = "murmur://inbox/agent-b";
    let resolveNotification: ((value: ResourceUpdatedNotification) => void) | null = null;
    const notificationPromise: Promise<ResourceUpdatedNotification> = new Promise(
      (resolvePromise: (value: ResourceUpdatedNotification) => void): void => {
        resolveNotification = resolvePromise;
      },
    );
    receiver.client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification: ResourceUpdatedNotification): void => {
        const resolver: ((value: ResourceUpdatedNotification) => void) | null = resolveNotification;
        if (resolver === null) throw new Error("Push resolver was not initialized");
        resolver(notification);
      },
    );
    await receiver.client.subscribeResource({ uri: inboxUri });

    const sent: SendMessageOutput = await callValidated(
      sender.client,
      "send_message",
      {
        content: "hello across MCP processes",
        idempotency_key: "e2e-message-1",
        recipient_id: "agent-b",
        sender_id: "agent-a",
      },
      SendMessageOutputSchema,
    );
    expect(sent.message.context.repository).toBe("mattpatagon/murmur");
    expect(sent.message.context.branch).toBe("feature/mcp-context");
    expect(sent.message.context.client).toBe("codex");
    expect(Object.hasOwn(sent.message, "broadcast_id")).toBe(false);
    expect(Number.isNaN(Date.parse(sent.message.created_at))).toBe(false);
    const pushed: ResourceUpdatedNotification = await Promise.race([
      notificationPromise,
      notificationTimeout(),
    ]);
    expect(pushed.params.uri).toBe(inboxUri);

    const resource: ReadResourceResult = await receiver.client.readResource({ uri: inboxUri });
    const content: ResourceContent | undefined = resource.contents[0];
    if (content === undefined || !("text" in content)) {
      throw new Error("Inbox resource did not return text content");
    }
    const parsedInbox: unknown = JSON.parse(content.text);
    const inbox: InboxOutput = InboxOutputSchema.parse(parsedInbox);
    expect(inbox.messages).toHaveLength(1);
    const inboxMessage: InboxOutput["messages"][number] | undefined = inbox.messages[0];
    if (inboxMessage === undefined) throw new Error("Expected one inbox message");
    expect(inboxMessage.context.repository).toBe("mattpatagon/murmur");
    expect(inboxMessage.context.branch).toBe("feature/mcp-context");
    expect(inboxMessage.context.client).toBe("codex");
    expect(inboxMessage.created_at).toBe(sent.message.created_at);
    expect(Object.hasOwn(inboxMessage, "broadcast_id")).toBe(false);

    const marked: MarkMessagesReadOutput = await callValidated(
      receiver.client,
      "mark_messages_read",
      {
        agent_id: "agent-b",
        message_ids: [sent.message.message_id],
      },
      MarkMessagesReadOutputSchema,
    );
    expect(marked.updated).toBe(1);
  } finally {
    await Promise.allSettled([sender.client.close(), receiver.client.close()]);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a broadcast fans out to every matching MCP inbox and pushes each update", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-broadcast-mcp-"));
  const databasePath: string = join(directory, "messages.db");
  const sender: ClientHarness = await connectClient("broadcast-sender", databasePath);
  const firstReceiver: ClientHarness = await connectClient("broadcast-receiver-1", databasePath);
  const secondReceiver: ClientHarness = await connectClient("broadcast-receiver-2", databasePath);
  const senderId: string = "mac-1:codex:sender:0001";
  const firstReceiverId: string = "mac-1:codex:receiver-1:0002";
  const secondReceiverId: string = "mac-1:claude:receiver-2:0003";
  try {
    const toolsResult: Awaited<ReturnType<Client["listTools"]>> = await sender.client.listTools();
    expect(
      toolsResult.tools.some(
        (tool: (typeof toolsResult.tools)[number]): boolean => tool.name === "broadcast_message",
      ),
    ).toBe(true);
    await callValidated(
      sender.client,
      "register_agent",
      { agent_id: senderId, display_name: "Broadcast Sender" },
      RegisterAgentOutputSchema,
    );
    await callValidated(
      firstReceiver.client,
      "register_agent",
      { agent_id: firstReceiverId, display_name: "Broadcast Receiver 1" },
      RegisterAgentOutputSchema,
    );
    await callValidated(
      secondReceiver.client,
      "register_agent",
      { agent_id: secondReceiverId, display_name: "Broadcast Receiver 2" },
      RegisterAgentOutputSchema,
    );

    const firstUri: string = `murmur://inbox/${firstReceiverId}`;
    const secondUri: string = `murmur://inbox/${secondReceiverId}`;
    const firstPush: Promise<ResourceUpdatedNotification> = new Promise(
      (resolvePush: (value: ResourceUpdatedNotification) => void): void => {
        firstReceiver.client.setNotificationHandler(ResourceUpdatedNotificationSchema, resolvePush);
      },
    );
    const secondPush: Promise<ResourceUpdatedNotification> = new Promise(
      (resolvePush: (value: ResourceUpdatedNotification) => void): void => {
        secondReceiver.client.setNotificationHandler(
          ResourceUpdatedNotificationSchema,
          resolvePush,
        );
      },
    );
    await Promise.all([
      firstReceiver.client.subscribeResource({ uri: firstUri }),
      secondReceiver.client.subscribeResource({ uri: secondUri }),
    ]);

    const broadcast: BroadcastMessageOutput = await callValidated(
      sender.client,
      "broadcast_message",
      {
        audience: { machine: "mac-1", repository: "mattpatagon/murmur" },
        content: "hello to every matching MCP process",
        idempotency_key: "broadcast-e2e-1",
        sender_id: senderId,
      },
      BroadcastMessageOutputSchema,
    );
    expect(broadcast.recipient_count).toBe(2);
    const pushes: ResourceUpdatedNotification[] = await Promise.race([
      Promise.all([firstPush, secondPush]),
      notificationTimeout(),
    ]);
    expect(
      pushes.map((push: ResourceUpdatedNotification): string => push.params.uri).sort(),
    ).toEqual([firstUri, secondUri].sort());

    const inboxes: InboxOutput[] = await Promise.all([
      callValidated(
        firstReceiver.client,
        "get_messages",
        { after_sequence: 0, agent_id: firstReceiverId, limit: 100, unread_only: false },
        InboxOutputSchema,
      ),
      callValidated(
        secondReceiver.client,
        "get_messages",
        { after_sequence: 0, agent_id: secondReceiverId, limit: 100, unread_only: false },
        InboxOutputSchema,
      ),
    ]);
    for (const inbox of inboxes) {
      expect(inbox.messages).toHaveLength(1);
      const message: InboxOutput["messages"][number] | undefined = inbox.messages[0];
      if (message === undefined) throw new Error("Expected one broadcast inbox message");
      expect(Object.hasOwn(message, "broadcast_id")).toBe(false);
      expect(message.thread_id).toBe(broadcast.thread_id);
      expect(message.content).toBe("hello to every matching MCP process");
    }
  } finally {
    await Promise.allSettled([
      sender.client.close(),
      firstReceiver.client.close(),
      secondReceiver.client.close(),
    ]);
    rmSync(directory, { force: true, recursive: true });
  }
}, 10_000);

test("generic MCP clients must provide complete message context", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-generic-mcp-"));
  const databasePath: string = join(directory, "messages.db");
  const sender: ClientHarness = await connectGenericClient(
    "generic-sender",
    databasePath,
    directory,
  );
  const receiver: ClientHarness = await connectGenericClient(
    "generic-receiver",
    databasePath,
    directory,
  );
  try {
    await callValidated(
      sender.client,
      "register_agent",
      { agent_id: "generic-a", display_name: "Generic A" },
      RegisterAgentOutputSchema,
    );
    await callValidated(
      receiver.client,
      "register_agent",
      { agent_id: "generic-b", display_name: "Generic B" },
      RegisterAgentOutputSchema,
    );

    const sent: SendMessageOutput = await callValidated(
      sender.client,
      "send_message",
      {
        content: "hello with explicit context",
        context: {
          branch: "feature/explicit-context",
          client: "claude",
          repository: "another/project",
        },
        recipient_id: "generic-b",
        sender_id: "generic-a",
      },
      SendMessageOutputSchema,
    );
    expect(sent.message.context).toEqual({
      branch: "feature/explicit-context",
      client: "claude",
      repository: "another/project",
    });

    const inbox: InboxOutput = await callValidated(
      receiver.client,
      "get_messages",
      {
        after_sequence: 0,
        agent_id: "generic-b",
        limit: 100,
        unread_only: false,
      },
      InboxOutputSchema,
    );
    const received: InboxOutput["messages"][number] | undefined = inbox.messages[0];
    if (received === undefined) throw new Error("Expected the explicitly contextualized message");
    expect(received.context).toEqual(sent.message.context);
    expect(received.created_at).toBe(sent.message.created_at);

    const missingRepository: CallToolResult = CallToolResultSchema.parse(
      await sender.client.callTool({
        arguments: {
          content: "missing repository",
          recipient_id: "generic-b",
          sender_id: "generic-a",
        },
        name: "send_message",
      }),
    );
    expect(missingRepository.isError).toBe(true);
    expect(JSON.stringify(missingRepository.content)).toContain(
      "Message repository context is required",
    );

    const missingBranch: CallToolResult = CallToolResultSchema.parse(
      await sender.client.callTool({
        arguments: {
          content: "missing branch",
          context: { repository: "another/project" },
          recipient_id: "generic-b",
          sender_id: "generic-a",
        },
        name: "send_message",
      }),
    );
    expect(missingBranch.isError).toBe(true);
    expect(JSON.stringify(missingBranch.content)).toContain("Message branch context is required");

    const missingClient: CallToolResult = CallToolResultSchema.parse(
      await sender.client.callTool({
        arguments: {
          content: "missing client",
          context: { branch: "feature/missing-client", repository: "another/project" },
          recipient_id: "generic-b",
          sender_id: "generic-a",
        },
        name: "send_message",
      }),
    );
    expect(missingClient.isError).toBe(true);
    expect(JSON.stringify(missingClient.content)).toContain("Message client context is required");

    const missingBroadcastRepository: CallToolResult = CallToolResultSchema.parse(
      await sender.client.callTool({
        arguments: {
          content: "broadcast missing repository",
          sender_id: "generic-a",
        },
        name: "broadcast_message",
      }),
    );
    expect(missingBroadcastRepository.isError).toBe(true);
    expect(JSON.stringify(missingBroadcastRepository.content)).toContain(
      "Message repository context is required",
    );

    const broadcast: BroadcastMessageOutput = await callValidated(
      sender.client,
      "broadcast_message",
      {
        content: "global broadcast with explicit context",
        context: {
          branch: "feature/explicit-context",
          client: "claude",
          repository: "another/project",
        },
        sender_id: "generic-a",
      },
      BroadcastMessageOutputSchema,
    );
    expect(broadcast.audience).toEqual({});
    expect(broadcast.recipient_count).toBe(1);
  } finally {
    await Promise.allSettled([sender.client.close(), receiver.client.close()]);
    rmSync(directory, { force: true, recursive: true });
  }
});
