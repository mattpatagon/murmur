import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CallToolResult,
  ReadResourceResult,
  ResourceUpdatedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  BroadcastMessageInput,
  CloseAgentInput,
  CloseAgentOutput,
  EndSessionInput,
  EndSessionOutput,
  GetAgentInput,
  GetAgentOutput,
  GetMessagesInput,
  ListAgentsInput,
  ListAgentsOutput,
  MarkMessagesReadInput,
  MarkMessagesReadOutput,
  RegisterAgentInput,
  RegisterAgentOutput,
  SendMessageInput,
  WaitForMessagesInput,
} from "../src/domain/contracts.js";
import {
  type SubmitFeedbackInput,
  type SubmitFeedbackOutput,
  SubmitFeedbackOutputSchema,
} from "../src/domain/feedback-contracts.js";
import {
  type CheckForUpgradesOutput,
  CheckForUpgradesOutputSchema,
  createUpgradeCheckOutput,
} from "../src/domain/upgrade-contracts.js";
import { E2eeProxyApplication } from "../src/e2ee/proxy-application.js";
import {
  type ProxyBroadcastOutput,
  ProxyBroadcastOutputSchema,
  type ProxyInboxOutput,
  ProxyInboxOutputSchema,
  type ProxyMessageDto,
  type ProxySendMessageOutput,
  ProxySendMessageOutputSchema,
  type ProxyWaitForMessagesOutput,
  ProxyWaitForMessagesOutputSchema,
} from "../src/e2ee/proxy-contracts.js";
import type { E2eeProxyOperations } from "../src/e2ee/proxy-service.js";
import type { MurmurUpgradeChecker } from "../src/mcp/murmur-upgrade-checker.js";

const NOW: string = "2026-08-10T20:00:00.000Z";
const EXPIRES: string = "2026-09-09T20:00:00.000Z";
const MESSAGE_ID: string = "00000000-0000-4000-8000-000000000001";
const BROADCAST_ID: string = "00000000-0000-4000-8000-000000000002";
const SENDER_ID: string = "machine-a:codex:repo:1";
const RECIPIENT_ID: string = "machine-b:codex:repo:2";
const ROOT_KEY_ID: string = `mrk_${"A".repeat(43)}`;
const AGENT_KEY_ID: string = `mak_${"B".repeat(43)}`;
const UPGRADE_REVISION: string = "c".repeat(40);

function proxyMessage(): ProxyMessageDto {
  return {
    content: "endpoint plaintext",
    context: {
      branch: "feature/e2ee",
      client: "codex",
      repository: "mattpatagon/murmur",
    },
    created_at: NOW,
    encryption: {
      context_binding: "verified",
      message_kind: "message",
      orchestrator_policy_id: null,
      protocol: "murmur-e2ee-v1",
      provenance: "sender_signed_server_asserted",
      recipient_prekey_class: "one_time",
      sender_agent_key_id: AGENT_KEY_ID,
      sender_authority: "peer",
      sender_root_key_id: ROOT_KEY_ID,
      verification_mode: "strict",
    },
    expires_at: EXPIRES,
    message_id: MESSAGE_ID,
    read_at: null,
    recipient_id: RECIPIENT_ID,
    sender_id: SENDER_ID,
    sequence: 1,
    thread_id: "thread-1",
  };
}

function registration(): RegisterAgentOutput {
  return {
    agent: {
      agent_id: SENDER_ID,
      authority: "peer",
      closed_at: null,
      close_reason: null,
      created_at: NOW,
      display_name: "Sender",
      generation: 1,
      last_seen_at: NOW,
      lease_expires_at: "2026-08-10T20:15:00.000Z",
      live_session_count: 1,
      metadata: {},
      state: "active",
    },
    inbox_uri: `murmur://inbox/${encodeURIComponent(SENDER_ID)}`,
    lease_minutes: 15,
    reopened: false,
    repository_diverged: false,
    retention_days: 30,
  };
}

class FakeProxyOperations implements E2eeProxyOperations {
  public readonly calls: string[] = [];
  #backgroundDelivered: boolean = false;
  #closed: boolean = false;

  public async registerAgent(_input: RegisterAgentInput): Promise<RegisterAgentOutput> {
    this.calls.push("register_agent");
    return registration();
  }

  public async listAgents(_input: ListAgentsInput): Promise<ListAgentsOutput> {
    this.calls.push("list_agents");
    const sender: RegisterAgentOutput["agent"] = registration().agent;
    return {
      agents: [sender, { ...sender, agent_id: RECIPIENT_ID, display_name: "Receiver" }],
      next_cursor: null,
    };
  }

  public async getAgent(_input: GetAgentInput): Promise<GetAgentOutput> {
    this.calls.push("get_agent");
    return { agent: registration().agent };
  }

  public async endSession(input: EndSessionInput): Promise<EndSessionOutput> {
    this.calls.push("end_session");
    return { ended: 1, generation: input.expected_generation };
  }

  public async closeAgent(_input: CloseAgentInput): Promise<CloseAgentOutput> {
    this.calls.push("close_agent");
    return {
      agent: {
        ...registration().agent,
        close_reason: "completed",
        closed_at: NOW,
        lease_expires_at: null,
        live_session_count: 0,
        state: "closed",
      },
      already_closed: false,
      ended_sessions: 1,
      unread_count: 0,
    };
  }

  public async sendMessage(_input: SendMessageInput): Promise<ProxySendMessageOutput> {
    this.calls.push("send_message");
    return {
      duplicate: false,
      message: proxyMessage(),
      retention_days: 30,
      status: "stored",
    };
  }

  public async submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackOutput> {
    this.calls.push("submit_feedback");
    return SubmitFeedbackOutputSchema.parse({
      duplicate: false,
      status: "stored",
      submission: {
        context: input.context ?? {
          branch: "feature/e2ee",
          client: "codex",
          repository: "mattpatagon/murmur",
        },
        created_at: NOW,
        description: input.description,
        reporter_generation: 1,
        reporter_id: input.reporter_id,
        submission_id: "00000000-0000-4000-8000-000000000003",
        title: input.title,
        type: input.type,
      },
    });
  }

  public async broadcastMessage(_input: BroadcastMessageInput): Promise<ProxyBroadcastOutput> {
    this.calls.push("broadcast_message");
    return {
      audience: { repository: "mattpatagon/murmur" },
      broadcast_id: BROADCAST_ID,
      created_at: NOW,
      duplicate: false,
      encryption: {
        protocol: "murmur-e2ee-v1",
        recipients: [{ recipient_id: RECIPIENT_ID, verification_mode: "strict" }],
      },
      expires_at: EXPIRES,
      recipient_count: 1,
      retention_days: 30,
      status: "stored",
      thread_id: "thread-1",
    };
  }

  public async getMessages(_input: GetMessagesInput): Promise<ProxyInboxOutput> {
    this.calls.push("get_messages");
    return { agent_id: RECIPIENT_ID, inbox_version: 1, messages: [proxyMessage()] };
  }

  public async waitForMessages(input: WaitForMessagesInput): Promise<ProxyWaitForMessagesOutput> {
    this.calls.push("wait_for_messages");
    if (input.timeout_seconds === 5) {
      if (!this.#backgroundDelivered) {
        this.#backgroundDelivered = true;
        return { agent_id: RECIPIENT_ID, messages: [proxyMessage()], timed_out: false };
      }
      await Bun.sleep(10);
      return { agent_id: RECIPIENT_ID, messages: [], timed_out: true };
    }
    return { agent_id: RECIPIENT_ID, messages: [proxyMessage()], timed_out: false };
  }

  public async markMessagesRead(_input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    this.calls.push("mark_messages_read");
    return { read_at: NOW, updated: 1 };
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.calls.push("close");
  }
}

class FailingCloseOperations extends FakeProxyOperations {
  public closeAttempts: number = 0;

  public override async close(): Promise<void> {
    this.closeAttempts += 1;
    throw new Error("sensitive internal close detail");
  }
}

async function callTool(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ arguments: arguments_, name }));
}

test("local E2E MCP proxy preserves familiar data tools and verified plaintext outputs", async (): Promise<void> => {
  const operations: FakeProxyOperations = new FakeProxyOperations();
  const upgradeOutput: CheckForUpgradesOutput = createUpgradeCheckOutput(
    "0.10.1.0",
    "0.10.2.0",
    UPGRADE_REVISION,
    new Date(NOW),
  );
  const upgradeChecker: MurmurUpgradeChecker = {
    checkForUpgrades: async (): Promise<CheckForUpgradesOutput> => upgradeOutput,
  };
  const application: E2eeProxyApplication = new E2eeProxyApplication(operations, upgradeChecker);
  const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
  const client: Client = new Client(
    { name: "proxy-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await application.server.connect(transports[1]);
  await client.connect(transports[0]);
  try {
    const listed: Awaited<ReturnType<Client["listTools"]>> = await client.listTools();
    expect(listed.tools.map((tool: (typeof listed.tools)[number]): string => tool.name)).toEqual([
      "register_agent",
      "get_agent",
      "list_agents",
      "end_session",
      "close_agent",
      "submit_feedback",
      "send_message",
      "get_orchestrator",
      "ask_orchestrator",
      "get_delegation",
      "broadcast_message",
      "get_messages",
      "wait_for_messages",
      "mark_messages_read",
      "get_setup_guide",
      "check_for_upgrades",
    ]);
    expect(
      listed.tools.some(
        (tool: (typeof listed.tools)[number]): boolean => tool.name === "put_encrypted_message",
      ),
    ).toBe(false);
    const feedbackTool: (typeof listed.tools)[number] | undefined = listed.tools.find(
      (tool: (typeof listed.tools)[number]): boolean => tool.name === "submit_feedback",
    );
    if (feedbackTool === undefined) throw new Error("Missing encrypted proxy feedback tool");
    expect(feedbackTool.description).toContain("maintainer-readable plaintext");
    expect(feedbackTool.description).toContain("security/advisories/new");

    const upgrade: CallToolResult = await callTool(client, "check_for_upgrades", {});
    expect(CheckForUpgradesOutputSchema.parse(upgrade.structuredContent)).toEqual(upgradeOutput);

    await callTool(client, "register_agent", {
      agent_id: SENDER_ID,
      display_name: "Sender",
    });
    await callTool(client, "get_agent", { agent_id: SENDER_ID });
    await callTool(client, "list_agents", { limit: 1_000, state: "active" });
    await callTool(client, "end_session", {
      agent_id: SENDER_ID,
      end_default_session: true,
      expected_generation: 1,
      reason: "stop",
      session_key: "pane-1",
    });
    const feedback: CallToolResult = await callTool(client, "submit_feedback", {
      description: "Keep feedback available through the encrypted proxy.",
      reporter_id: SENDER_ID,
      title: "Encrypted proxy feedback",
      type: "feature_request",
    });
    expect(SubmitFeedbackOutputSchema.parse(feedback.structuredContent)).toMatchObject({
      duplicate: false,
      submission: { reporter_id: SENDER_ID, type: "feature_request" },
    });
    const sent: CallToolResult = await callTool(client, "send_message", {
      content: "endpoint plaintext",
      recipient_id: RECIPIENT_ID,
      sender_id: SENDER_ID,
    });
    const sentOutput: ProxySendMessageOutput = ProxySendMessageOutputSchema.parse(
      sent.structuredContent,
    );
    expect(sentOutput.message.content).toBe("endpoint plaintext");
    expect(sentOutput.message.encryption).toMatchObject({
      context_binding: "verified",
      protocol: "murmur-e2ee-v1",
      verification_mode: "strict",
    });

    const broadcast: CallToolResult = await callTool(client, "broadcast_message", {
      audience: { repository: "mattpatagon/murmur" },
      content: "endpoint plaintext",
      sender_id: SENDER_ID,
    });
    expect(ProxyBroadcastOutputSchema.parse(broadcast.structuredContent).recipient_count).toBe(1);

    const inbox: CallToolResult = await callTool(client, "get_messages", {
      after_sequence: 0,
      agent_id: RECIPIENT_ID,
      limit: 100,
      unread_only: false,
    });
    expect(ProxyInboxOutputSchema.parse(inbox.structuredContent).messages[0]).toEqual(
      proxyMessage(),
    );
    const waited: CallToolResult = await callTool(client, "wait_for_messages", {
      after_sequence: 0,
      agent_id: RECIPIENT_ID,
      timeout_seconds: 20,
    });
    expect(ProxyWaitForMessagesOutputSchema.parse(waited.structuredContent).timed_out).toBe(false);
    await callTool(client, "mark_messages_read", {
      agent_id: RECIPIENT_ID,
      message_ids: [MESSAGE_ID],
    });
    await callTool(client, "close_agent", {
      agent_id: SENDER_ID,
      expected_generation: 1,
      reason: "completed",
    });

    expect(operations.calls).toEqual([
      "register_agent",
      "get_agent",
      "list_agents",
      "end_session",
      "submit_feedback",
      "send_message",
      "broadcast_message",
      "get_messages",
      "wait_for_messages",
      "mark_messages_read",
      "close_agent",
    ]);

    const resources: Awaited<ReturnType<Client["listResources"]>> = await client.listResources();
    const inboxUri: string = `murmur://inbox/${encodeURIComponent(SENDER_ID)}`;
    expect(resources.resources).toEqual([
      {
        description: `End-to-end encrypted inbox for ${SENDER_ID}`,
        mimeType: "application/json",
        name: "Sender encrypted inbox",
        uri: inboxUri,
      },
      {
        description: `End-to-end encrypted inbox for ${RECIPIENT_ID}`,
        mimeType: "application/json",
        name: "Receiver encrypted inbox",
        uri: `murmur://inbox/${encodeURIComponent(RECIPIENT_ID)}`,
      },
    ]);
    let resolveUpdated: ((notification: ResourceUpdatedNotification) => void) | null = null;
    const updated: Promise<ResourceUpdatedNotification> = new Promise(
      (resolvePromise: (notification: ResourceUpdatedNotification) => void): void => {
        resolveUpdated = resolvePromise;
      },
    );
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification: ResourceUpdatedNotification): void => {
        const resolver: ((value: ResourceUpdatedNotification) => void) | null = resolveUpdated;
        if (resolver !== null) resolver(notification);
      },
    );
    const recipientUri: string = `murmur://inbox/${encodeURIComponent(RECIPIENT_ID)}`;
    await client.subscribeResource({ uri: recipientUri });
    const notification: ResourceUpdatedNotification = await Promise.race([
      updated,
      Bun.sleep(1_000).then((): never => {
        throw new Error("Timed out waiting for the local encrypted inbox notification");
      }),
    ]);
    expect(notification.params.uri).toBe(recipientUri);
    const resource: ReadResourceResult = await client.readResource({ uri: recipientUri });
    const content: ReadResourceResult["contents"][number] | undefined = resource.contents[0];
    if (content === undefined || !("text" in content)) {
      throw new Error("Expected a decrypted local inbox resource");
    }
    expect(ProxyInboxOutputSchema.parse(JSON.parse(content.text)).messages[0]).toEqual(
      proxyMessage(),
    );
    await client.unsubscribeResource({ uri: recipientUri });

    const invalid: CallToolResult = await callTool(client, "send_message", {
      content: "",
      recipient_id: RECIPIENT_ID,
      sender_id: SENDER_ID,
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("endpoint plaintext");
  } finally {
    await Promise.allSettled([client.close(), application.close()]);
  }
  expect(operations.calls.at(-1)).toBe("close");
});

test("local E2E proxy closes its MCP transport even when endpoint cleanup fails", async (): Promise<void> => {
  const operations: FailingCloseOperations = new FailingCloseOperations();
  const application: E2eeProxyApplication = new E2eeProxyApplication(operations);
  const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
  const client: Client = new Client(
    { name: "proxy-cleanup-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await application.server.connect(transports[1]);
  await client.connect(transports[0]);
  await expect(application.close()).rejects.toThrow("local E2E proxy shutdown failed");
  await expect(application.close()).rejects.toThrow("local E2E proxy shutdown failed");
  expect(operations.closeAttempts).toBe(1);
  await expect(client.listTools()).rejects.toThrow();
  await client.close();
});
