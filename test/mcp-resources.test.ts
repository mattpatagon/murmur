import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  ListResourcesResult,
  ListResourceTemplatesResult,
  MessageExtraInfo,
  ReadResourceResult,
  ResourceListChangedNotification,
  ResourceUpdatedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  type InboxOutput,
  CloseAgentOutputSchema,
  EndSessionOutputSchema,
  InboxOutputSchema,
  RegisterAgentOutputSchema,
  type RegisterAgentOutput,
  SendMessageOutputSchema,
  type WaitForMessagesOutput,
  WaitForMessagesOutputSchema,
} from "../src/domain/contracts.js";
import { AgentClient, BranchName, RepositoryName } from "../src/domain/value-objects.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { callValidated, notificationTimeout } from "./support/mcp-client-harness.js";

class MemoryTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private closed: boolean;
  private peer: MemoryTransport | null;

  public constructor() {
    this.closed = false;
    this.peer = null;
  }

  public connectPeer(peer: MemoryTransport): void {
    this.peer = peer;
  }

  public async start(): Promise<void> {}

  public async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("Memory transport is closed");
    const peer: MemoryTransport | null = this.peer;
    if (peer === null) throw new Error("Memory transport has no peer");
    const receiver:
      | (<T extends JSONRPCMessage>(received: T, extra?: MessageExtraInfo) => void)
      | undefined = peer.onmessage;
    if (receiver === undefined) throw new Error("Memory transport peer is not started");
    receiver(message);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closeHandler: (() => void) | undefined = this.onclose;
    if (closeHandler !== undefined) closeHandler();
  }
}

type ConnectedApplication = {
  readonly application: MurmurApplication;
  readonly client: Client;
};

async function connectApplication(): Promise<ConnectedApplication> {
  const clientTransport: MemoryTransport = new MemoryTransport();
  const serverTransport: MemoryTransport = new MemoryTransport();
  clientTransport.connectPeer(serverTransport);
  serverTransport.connectPeer(clientTransport);
  const application: MurmurApplication = new MurmurApplication({
    branchName: BranchName.parse("feature/resource-coverage"),
    client: AgentClient.parse("codex"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    store: new SqliteMessageStore(":memory:"),
  });
  const client: Client = new Client(
    { name: "resource-coverage-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await application.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { application, client };
}

test("MCP resources expose durable inboxes and validate subscription lifecycle", async (): Promise<void> => {
  const connected: ConnectedApplication = await connectApplication();
  const client: Client = connected.client;
  try {
    const emptyResources: ListResourcesResult = await client.listResources();
    const templates: ListResourceTemplatesResult = await client.listResourceTemplates();
    expect(emptyResources.resources).toEqual([]);
    expect(templates.resourceTemplates).toHaveLength(1);

    await callValidated(
      client,
      "register_agent",
      { agent_id: "machine-a:sender", display_name: "Sender" },
      RegisterAgentOutputSchema,
    );
    await callValidated(
      client,
      "register_agent",
      { agent_id: "machine-a:receiver", display_name: "Receiver" },
      RegisterAgentOutputSchema,
    );
    const resources: ListResourcesResult = await client.listResources();
    expect(resources.resources).toHaveLength(2);

    const receiverUri: string = "murmur://inbox/machine-a%3Areceiver";
    const emptyInboxResource: ReadResourceResult = await client.readResource({ uri: receiverUri });
    const emptyContent: ReadResourceResult["contents"][number] | undefined =
      emptyInboxResource.contents[0];
    if (emptyContent === undefined || !("text" in emptyContent)) {
      throw new Error("Inbox resource did not contain JSON text");
    }
    expect(InboxOutputSchema.parse(JSON.parse(emptyContent.text)).messages).toEqual([]);

    await client.subscribeResource({ uri: receiverUri });
    await client.subscribeResource({ uri: receiverUri });
    const update: Promise<ResourceUpdatedNotification> = new Promise(
      (resolve: (notification: ResourceUpdatedNotification) => void): void => {
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, resolve);
      },
    );
    await callValidated(
      client,
      "send_message",
      {
        content: "resource-backed delivery",
        recipient_id: "machine-a:receiver",
        sender_id: "machine-a:sender",
      },
      SendMessageOutputSchema,
    );
    expect((await Promise.race([update, notificationTimeout()])).params.uri).toBe(receiverUri);

    const populatedResource: ReadResourceResult = await client.readResource({ uri: receiverUri });
    const populatedContent: ReadResourceResult["contents"][number] | undefined =
      populatedResource.contents[0];
    if (populatedContent === undefined || !("text" in populatedContent)) {
      throw new Error("Populated inbox resource did not contain JSON text");
    }
    const inbox: InboxOutput = InboxOutputSchema.parse(JSON.parse(populatedContent.text));
    expect(
      inbox.messages.map((message: InboxOutput["messages"][number]): string => message.content),
    ).toEqual(["resource-backed delivery"]);

    await client.unsubscribeResource({ uri: receiverUri });
    await client.unsubscribeResource({ uri: receiverUri });
    await expect(client.subscribeResource({ uri: "https://example.com/inbox" })).rejects.toThrow(
      "Unsupported resource URI",
    );
    await expect(client.subscribeResource({ uri: "murmur://inbox/%2F" })).rejects.toThrow(
      "Invalid inbox resource URI",
    );
    await expect(
      client.subscribeResource({ uri: "murmur://inbox/machine-a%3Aunknown" }),
    ).rejects.toThrow("Unknown agent");
  } finally {
    await client.close();
    await connected.application.close();
  }
});

test("reactivating known inactive and closed agents emits resource-list changes", async (): Promise<void> => {
  const connected: ConnectedApplication = await connectApplication();
  const client: Client = connected.client;
  const agentId: string = "resource-reactivation-agent";
  const nextListChange: () => Promise<ResourceListChangedNotification> =
    (): Promise<ResourceListChangedNotification> =>
      new Promise((resolve: (value: ResourceListChangedNotification) => void): void => {
        client.setNotificationHandler(ResourceListChangedNotificationSchema, resolve);
      });
  try {
    await callValidated(
      client,
      "register_agent",
      { agent_id: agentId, session_key: "default" },
      RegisterAgentOutputSchema,
    );
    let changed: Promise<ResourceListChangedNotification> = nextListChange();
    await callValidated(
      client,
      "end_session",
      {
        agent_id: agentId,
        end_default_session: false,
        expected_generation: 1,
        reason: "stop",
        session_key: "default",
      },
      EndSessionOutputSchema,
    );
    await Promise.race([changed, notificationTimeout()]);
    expect((await client.listResources()).resources).toHaveLength(0);

    changed = nextListChange();
    await callValidated(
      client,
      "register_agent",
      { agent_id: agentId, session_key: "returned" },
      RegisterAgentOutputSchema,
    );
    await Promise.race([changed, notificationTimeout()]);
    expect((await client.listResources()).resources).toHaveLength(1);

    changed = nextListChange();
    await callValidated(
      client,
      "close_agent",
      { agent_id: agentId, expected_generation: 1, reason: "manual" },
      CloseAgentOutputSchema,
    );
    await Promise.race([changed, notificationTimeout()]);
    expect((await client.listResources()).resources).toHaveLength(0);

    changed = nextListChange();
    const reopened: RegisterAgentOutput = await callValidated(
      client,
      "register_agent",
      { agent_id: agentId, session_key: "reopened" },
      RegisterAgentOutputSchema,
    );
    expect(reopened.agent.generation).toBe(2);
    await Promise.race([changed, notificationTimeout()]);
    expect((await client.listResources()).resources).toHaveLength(1);
  } finally {
    await client.close();
    await connected.application.close();
  }
});

test("wait_for_messages covers immediate, notified, and timeout outcomes", async (): Promise<void> => {
  const connected: ConnectedApplication = await connectApplication();
  const client: Client = connected.client;
  try {
    for (const agentId of ["wait-sender", "wait-receiver", "empty-receiver"]) {
      await callValidated(
        client,
        "register_agent",
        { agent_id: agentId, display_name: agentId },
        RegisterAgentOutputSchema,
      );
    }

    const notifiedWait: Promise<WaitForMessagesOutput> = callValidated(
      client,
      "wait_for_messages",
      { after_sequence: 0, agent_id: "wait-receiver", timeout_seconds: 2 },
      WaitForMessagesOutputSchema,
    );
    await Bun.sleep(20);
    await callValidated(
      client,
      "send_message",
      {
        content: "wake the waiter",
        recipient_id: "wait-receiver",
        sender_id: "wait-sender",
      },
      SendMessageOutputSchema,
    );
    const notified: WaitForMessagesOutput = await notifiedWait;
    expect(notified.timed_out).toBe(false);
    expect(notified.messages).toHaveLength(1);

    const immediate: WaitForMessagesOutput = await callValidated(
      client,
      "wait_for_messages",
      { after_sequence: 0, agent_id: "wait-receiver", timeout_seconds: 1 },
      WaitForMessagesOutputSchema,
    );
    expect(immediate.timed_out).toBe(false);
    expect(immediate.messages).toHaveLength(1);

    const timedOut: WaitForMessagesOutput = await callValidated(
      client,
      "wait_for_messages",
      { after_sequence: 0, agent_id: "empty-receiver", timeout_seconds: 1 },
      WaitForMessagesOutputSchema,
    );
    expect(timedOut.timed_out).toBe(true);
    expect(timedOut.messages).toEqual([]);
  } finally {
    await client.close();
    await connected.application.close();
  }
});
