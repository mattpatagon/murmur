import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "../src/domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  DisplayName,
  MessageContent,
  RepositoryName,
  Sequence,
} from "../src/domain/value-objects.js";
import {
  type AgentIdentity,
  checkRemoteInbox,
  deriveAgentIdentity,
  type InboxSummary,
} from "../src/hook.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import {
  initializeSession,
  postJson,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

const API_TOKEN: string = "test-murmur-api-token";

function onlyMessage(messages: readonly Message[]): Message {
  const message: Message | undefined = messages[0];
  if (message === undefined || messages.length !== 1) {
    throw new Error("Expected exactly one inbox message");
  }
  return message;
}

test("hooks leave messages unread until the agent calls get_messages", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-inbox-receipt-"));
  const databasePath: string = join(directory, "messages.db");
  const server: MurmurHttpServer = await startHttpServer(testEnvironment(databasePath));
  const identity: AgentIdentity = deriveAgentIdentity("codex", directory, {
    MURMUR_BRANCH: "feature/hook-receipt",
    MURMUR_MACHINE_ID: "test-machine",
    MURMUR_REPOSITORY: "mattpatagon/murmur",
  });
  const agentId: AgentId = AgentId.parse(identity.agentId);
  const senderId: AgentId = AgentId.parse("test-machine:codex:sender:1234567890");
  const query: Parameters<SqliteMessageStore["getMessages"]>[0] = {
    afterSequence: Sequence.zero(),
    agentId,
    generation: null,
    limit: 100,
    sessionKey: null,
    threadId: null,
    unreadOnly: false,
  };
  try {
    await checkRemoteInbox(identity, {
      timeoutMs: 2_000,
      token: API_TOKEN,
      url: server.mcpUrl.toString(),
    });
    const verificationStore: SqliteMessageStore = new SqliteMessageStore(databasePath);
    try {
      verificationStore.registerAgent({
        agentId: senderId,
        displayName: DisplayName.parse("Hook receipt sender"),
        metadata: { machine: "test-machine", repository: "mattpatagon/murmur" },
      });
      verificationStore.sendMessage({
        branchName: BranchName.parse("feature/hook-receipt"),
        client: AgentClient.parse("codex"),
        content: MessageContent.parse("hook receipt regression"),
        idempotencyKey: null,
        recipientId: agentId,
        repositoryName: RepositoryName.parse("mattpatagon/murmur"),
        senderId,
        threadId: null,
      });

      const summary: InboxSummary = await checkRemoteInbox(identity, {
        timeoutMs: 2_000,
        token: API_TOKEN,
        url: server.mcpUrl.toString(),
      });
      expect(summary.messageCount).toBe(1);
      expect(summary.senderIds).toEqual([senderId.value]);
      expect(onlyMessage(verificationStore.getMessages(query)).readAt).toBeNull();

      const sessionId: string = await initializeSession(server.mcpUrl, "agent-inbox-reader");
      const response: Response = await postJson(
        server.mcpUrl,
        {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              after_sequence: 0,
              agent_id: identity.agentId,
              limit: 100,
              unread_only: true,
            },
            name: "get_messages",
          },
        },
        sessionId,
      );
      expect(response.status).toBe(200);
      await responsePayload(response);
      expect(onlyMessage(verificationStore.getMessages(query)).readAt).not.toBeNull();
    } finally {
      verificationStore.close();
    }
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
