import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoticeContent, SessionKey } from "../src/domain/lifecycle-values.js";
import type { Agent } from "../src/domain/models.js";
import { AgentId, IdempotencyKey, RepositoryName } from "../src/domain/value-objects.js";
import {
  checkRemoteInbox,
  deriveAgentIdentity,
  endRemoteAgentSession,
  handleHook,
  hookSessionKey,
  type AgentIdentity,
  type HookOutput,
  type InboxSummary,
} from "../src/hook.js";
import { startHttpServer, type MurmurHttpServer } from "../src/http-server.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

function requireAgent(store: SqliteMessageStore, id: string): Agent {
  const agent: Agent | null = store.getAgent(AgentId.parse(id));
  if (agent === null) {
    throw new Error(`Expected agent ${id}`);
  }
  return agent;
}

test("hook session keys are deterministic hashes that never expose raw host session IDs", (): void => {
  const raw: string = "host-session-super-secret-value";
  const first: string = hookSessionKey(raw);
  expect(first).toBe(hookSessionKey(raw));
  expect(first).toStartWith("hook-");
  expect(first).not.toContain(raw);
  expect(first).not.toBe(hookSessionKey("another-session"));
  expect(hookSessionKey(undefined)).toBe("default");
});

test("Stop bypasses debounce, does not check the inbox, and ends hash plus default", async (): Promise<void> => {
  let checked: boolean = false;
  let endedSessionKey: string = "";
  let endedEvent: string = "";
  const rawSessionId: string = "stop-session-id";
  const output: HookOutput | null = await handleHook(
    {
      cwd: "/work/repo",
      hook_event_name: "Stop",
      session_id: rawSessionId,
    },
    "codex",
    {
      checkInbox: async (): Promise<InboxSummary> => {
        checked = true;
        return { inboxVersion: 0, messageCount: 0, senderIds: [] };
      },
      debounceMs: 60_000,
      endSession: async (
        _identity: AgentIdentity,
        options: {
          readonly eventName: "SessionEnd" | "Stop";
          readonly sessionKey: string;
          readonly token: string;
          readonly timeoutMs: number;
          readonly url: string;
        },
      ): Promise<void> => {
        endedSessionKey = options.sessionKey;
        endedEvent = options.eventName;
      },
      environment: { MURMUR_API_TOKEN: "test-token", MURMUR_MACHINE_ID: "vm" },
      now: 1,
    },
  );
  expect(output).toBeNull();
  expect(checked).toBe(false);
  expect(endedEvent).toBe("Stop");
  expect(endedSessionKey).toBe(hookSessionKey(rawSessionId));
});

test("real hook teardown preserves another pane and SessionStart reports open notices", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-lifecycle-"));
  const token: string = "hook-lifecycle-token";
  const databasePath: string = join(directory, "messages.db");
  const server: MurmurHttpServer = await startHttpServer({
    MURMUR_API_TOKEN: token,
    MURMUR_DB_PATH: databasePath,
    MURMUR_HTTP_HOST: "127.0.0.1",
    MURMUR_LOG_LEVEL: "off",
    PORT: "0",
  });
  const identity: AgentIdentity = deriveAgentIdentity("codex", directory, {
    MURMUR_BRANCH: "feature/lifecycle",
    MURMUR_MACHINE_ID: "hook-machine",
    MURMUR_REPOSITORY: "mattpatagon/murmur",
  });
  const url: string = server.mcpUrl.toString();
  try {
    await checkRemoteInbox(identity, { sessionKey: "hook-pane-a", timeoutMs: 2_000, token, url });
    await checkRemoteInbox(identity, { sessionKey: "hook-pane-b", timeoutMs: 2_000, token, url });
    const verificationStore: SqliteMessageStore = new SqliteMessageStore(databasePath);
    try {
      expect(requireAgent(verificationStore, identity.agentId).liveSessionCount).toBe(2);
      verificationStore.postNotice({
        actorId: AgentId.parse(identity.agentId),
        branchName: null,
        content: NoticeContent.parse("handoff before the next session"),
        expiresInHours: 24,
        idempotencyKey: IdempotencyKey.parse("hook-notice"),
        kind: "handoff",
        repositoryName: RepositoryName.parse("mattpatagon/murmur"),
        sessionKey: SessionKey.parse("hook-pane-b"),
      });
      const start: InboxSummary = await checkRemoteInbox(identity, {
        includeNotices: true,
        sessionKey: "hook-pane-b",
        timeoutMs: 2_000,
        token,
        url,
      });
      expect(start.noticeCount).toBe(1);
      await endRemoteAgentSession(identity, {
        eventName: "Stop",
        sessionKey: "hook-pane-a",
        timeoutMs: 2_000,
        token,
        url,
      });
      expect(requireAgent(verificationStore, identity.agentId).liveSessionCount).toBe(1);
      await endRemoteAgentSession(identity, {
        eventName: "SessionEnd",
        sessionKey: "hook-pane-b",
        timeoutMs: 2_000,
        token,
        url,
      });
      expect(requireAgent(verificationStore, identity.agentId).state).toBe("inactive");
    } finally {
      verificationStore.close();
    }
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
