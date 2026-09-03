import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoticeContent, SessionKey } from "../src/domain/lifecycle-values.js";
import type { Agent } from "../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  IdempotencyKey,
  RepositoryName,
} from "../src/domain/value-objects.js";
import {
  type AgentIdentity,
  checkRemoteInbox,
  deriveAgentIdentity,
  endRemoteAgentSession,
  type HookOutput,
  handleHook,
  hookSessionKey,
  type InboxSummary,
} from "../src/hook.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

function requireAgent(store: SqliteMessageStore, id: string): Agent {
  const agent: Agent | null = store.getAgent(AgentId.parse(id));
  if (agent === null) {
    throw new Error(`Expected agent ${id}`);
  }
  return agent;
}

type EndSessionOptions = {
  readonly closeAgent: boolean;
  readonly eventName: "SessionEnd" | "Stop";
  readonly expectedGeneration: number;
  readonly sessionKey: string;
  readonly timeoutMs: number;
  readonly token: string;
  readonly url: string;
};

test("hook session keys are deterministic hashes that never expose raw host session IDs", (): void => {
  const raw: string = "host-session-super-secret-value";
  const first: string = hookSessionKey(raw);
  expect(first).toBe(hookSessionKey(raw));
  expect(first).toStartWith("hook-");
  expect(first).not.toContain(raw);
  expect(first).not.toBe(hookSessionKey("another-session"));
  expect(hookSessionKey(undefined)).toBe("default");
});

test("Stop ends the lease and SessionEnd closes a named automatic identity", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-stop-"));
  let checked: boolean = false;
  const ended: {
    readonly closeAgent: boolean;
    readonly eventName: string;
    readonly generation: number;
    readonly sessionKey: string;
  }[] = [];
  const rawSessionId: string = "stop-session-id";
  const environment: NodeJS.ProcessEnv = {
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "vm",
  };
  const checkInbox: () => Promise<InboxSummary> = async (): Promise<InboxSummary> => {
    checked = true;
    return { agentGeneration: 7, inboxVersion: 0, messageCount: 0, senderIds: [] };
  };
  try {
    await handleHook(
      { cwd: "/work/repo", hook_event_name: "SessionStart", session_id: rawSessionId },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 0 },
    );
    checked = false;
    const output: HookOutput | null = await handleHook(
      {
        cwd: "/work/repo",
        hook_event_name: "Stop",
        session_id: rawSessionId,
      },
      "codex",
      {
        cacheDirectory: directory,
        checkInbox,
        debounceMs: 60_000,
        endSession: async (_identity: AgentIdentity, options: EndSessionOptions): Promise<void> => {
          ended.push({
            closeAgent: options.closeAgent,
            eventName: options.eventName,
            generation: options.expectedGeneration,
            sessionKey: options.sessionKey,
          });
        },
        environment,
        now: 1,
      },
    );
    expect(output).toBeNull();
    expect(checked).toBe(false);
    expect(ended).toEqual([
      {
        closeAgent: false,
        eventName: "Stop",
        generation: 7,
        sessionKey: hookSessionKey(rawSessionId),
      },
    ]);
    await handleHook(
      { cwd: "/work/repo", hook_event_name: "SessionEnd", session_id: rawSessionId },
      "codex",
      {
        cacheDirectory: directory,
        endSession: async (_identity: AgentIdentity, options: EndSessionOptions): Promise<void> => {
          ended.push({
            closeAgent: options.closeAgent,
            eventName: options.eventName,
            generation: options.expectedGeneration,
            sessionKey: options.sessionKey,
          });
        },
        environment,
      },
    );
    expect(ended[1]).toEqual({
      closeAgent: true,
      eventName: "SessionEnd",
      generation: 7,
      sessionKey: hookSessionKey(rawSessionId),
    });
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SessionEnd clears its hook cache without a saved generation", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-missing-generation-"));
  let destructiveCalls: number = 0;
  const environment: NodeJS.ProcessEnv = {
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "vm",
  };
  try {
    await handleHook(
      { cwd: "/work/repo", hook_event_name: "SessionStart", session_id: "ended-session" },
      "codex",
      {
        cacheDirectory: directory,
        checkInbox: async (): Promise<InboxSummary> => ({
          agentGeneration: 7,
          inboxVersion: 0,
          messageCount: 0,
          senderIds: [],
        }),
        environment,
        now: 1,
      },
    );
    const cacheFiles: readonly string[] = readdirSync(directory);
    const generationFile: string | undefined = cacheFiles.find((file: string): boolean =>
      file.endsWith(".session.json"),
    );
    const ordinaryCache: string | undefined = cacheFiles.find(
      (file: string): boolean => file.endsWith(".json") && !file.endsWith(".session.json"),
    );
    if (generationFile === undefined || ordinaryCache === undefined) {
      throw new Error("Expected hook generation and notification cache files");
    }
    expect(cacheFiles).toContain(ordinaryCache);
    rmSync(join(directory, generationFile));

    await handleHook(
      { cwd: "/work/repo", hook_event_name: "SessionEnd", session_id: "ended-session" },
      "codex",
      {
        cacheDirectory: directory,
        endSession: async (): Promise<void> => {
          destructiveCalls += 1;
        },
        environment,
      },
    );
    expect(destructiveCalls).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("more than one thousand sequential automatic identities release open capacity", (): void => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
  try {
    for (let index: number = 0; index < 1_001; index += 1) {
      const identity: AgentIdentity = deriveAgentIdentity(
        "codex",
        "/work/repo",
        { MURMUR_MACHINE_ID: "vm" },
        `session-${index}`,
      );
      const registered: ReturnType<SqliteMessageStore["registerAgent"]> = store.registerAgent({
        agentId: AgentId.parse(identity.agentId),
        displayName: DisplayName.parse(identity.displayName),
        metadata: {},
        sessionKey: SessionKey.parse(hookSessionKey(`session-${index}`)),
      });
      store.closeAgent({
        agentId: AgentId.parse(identity.agentId),
        closeReason: "completed",
        expectedGeneration: registered.agent.generation,
      });
    }
  } finally {
    store.close();
  }
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
    await checkRemoteInbox(identity, { timeoutMs: 2_000, token, url });
    await checkRemoteInbox(identity, { sessionKey: "hook-pane-a", timeoutMs: 2_000, token, url });
    await checkRemoteInbox(identity, { sessionKey: "hook-pane-b", timeoutMs: 2_000, token, url });
    const verificationStore: SqliteMessageStore = new SqliteMessageStore(databasePath);
    try {
      expect(requireAgent(verificationStore, identity.agentId).liveSessionCount).toBe(3);
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
        closeAgent: false,
        eventName: "Stop",
        expectedGeneration: 1,
        sessionKey: "hook-pane-a",
        timeoutMs: 2_000,
        token,
        url,
      });
      expect(requireAgent(verificationStore, identity.agentId).liveSessionCount).toBe(1);
      await endRemoteAgentSession(identity, {
        closeAgent: true,
        eventName: "SessionEnd",
        expectedGeneration: 1,
        sessionKey: "hook-pane-b",
        timeoutMs: 2_000,
        token,
        url,
      });
      expect(requireAgent(verificationStore, identity.agentId).state).toBe("closed");
    } finally {
      verificationStore.close();
    }
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
