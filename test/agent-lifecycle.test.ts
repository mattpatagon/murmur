import { Database, type Statement } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentGeneration,
  MAX_RETAINED_SESSIONS_PER_AGENT,
  SessionKey,
} from "../src/domain/lifecycle-values.js";
import type {
  Agent,
  CloseAgentResult,
  EndSessionResult,
  Message,
  RegisterAgentResult,
  SendMessageCommand,
  SendMessageResult,
} from "../src/domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  DisplayName,
  IdempotencyKey,
  Instant,
  MessageContent,
  RepositoryName,
  Sequence,
} from "../src/domain/value-objects.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

type LifecycleFixture = {
  readonly clock: MutableClock;
  readonly path: string;
  readonly store: SqliteMessageStore;
};

function withLifecycle(run: (fixture: LifecycleFixture) => void): void {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-lifecycle-"));
  const path: string = join(directory, "messages.db");
  const clock: MutableClock = new MutableClock(Instant.parse("2026-01-01T00:00:00.000Z"));
  const store: SqliteMessageStore = new SqliteMessageStore(path, clock);
  try {
    run({ clock, path, store });
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function register(
  store: SqliteMessageStore,
  id: string,
  repository: string,
  session: string = "default",
): RegisterAgentResult {
  return store.registerAgent({
    agentId: AgentId.parse(id),
    displayName: DisplayName.parse(id),
    metadata: { repository },
    sessionKey: SessionKey.parse(session),
  });
}

function messageCommand(key: string = "lifecycle-message"): SendMessageCommand {
  return {
    branchName: BranchName.parse("feature/lifecycle"),
    client: AgentClient.parse("codex"),
    content: MessageContent.parse("generation-bound delivery"),
    idempotencyKey: IdempotencyKey.parse(key),
    recipientId: AgentId.parse("bob"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    senderId: AgentId.parse("alice"),
    sessionKey: SessionKey.parse("alice-pane"),
    threadId: null,
  };
}

function requireAgent(store: SqliteMessageStore, id: string): Agent {
  const agent: Agent | null = store.getAgent(AgentId.parse(id));
  if (agent === null) {
    throw new Error(`Expected agent ${id}`);
  }
  return agent;
}

test("session leases expire at the exact boundary and observer reads never create leases", (): void => {
  withLifecycle(({ clock, store }: LifecycleFixture): void => {
    register(store, "alice", "mattpatagon/murmur", "pane-a");
    clock.set(Instant.parse("2026-01-01T00:59:59.999Z"));
    expect(requireAgent(store, "alice").state).toBe("active");
    store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("alice"),
      limit: 10,
      sessionKey: SessionKey.parse("observer-that-does-not-exist"),
      threadId: null,
      unreadOnly: false,
    });
    clock.set(Instant.parse("2026-01-01T01:00:00.000Z"));
    expect(store.listAgents({ state: "active" })).toHaveLength(0);
    expect(
      store.listAgents({ state: "inactive" }).map((agent: Agent): string => agent.agentId.value),
    ).toEqual(["alice"]);
  });
});

test("Stop ends its hashed and default leases while another pane remains active", (): void => {
  withLifecycle(({ store }: LifecycleFixture): void => {
    register(store, "alice", "mattpatagon/murmur");
    register(store, "alice", "mattpatagon/murmur", "hook-pane-a");
    register(store, "alice", "mattpatagon/murmur", "hook-pane-b");
    const ended: EndSessionResult = store.endSession({
      agentId: AgentId.parse("alice"),
      endDefaultSession: true,
      endReason: "stop",
      expectedGeneration: null,
      sessionKey: SessionKey.parse("hook-pane-a"),
    });
    expect(ended.ended).toBe(2);
    expect(requireAgent(store, "alice").liveSessionCount).toBe(1);
    store.endSession({
      agentId: AgentId.parse("alice"),
      endDefaultSession: false,
      endReason: "stop",
      expectedGeneration: null,
      sessionKey: SessionKey.parse("hook-pane-b"),
    });
    expect(requireAgent(store, "alice").state).toBe("inactive");
  });
});

test("a ninth live session deterministically supersedes only the oldest lease", (): void => {
  withLifecycle(({ store }: LifecycleFixture): void => {
    for (let index: number = 1; index <= 9; index += 1) {
      register(store, "alice", "mattpatagon/murmur", `pane-${index}`);
    }
    expect(requireAgent(store, "alice").liveSessionCount).toBe(8);
    const oldest: EndSessionResult = store.endSession({
      agentId: AgentId.parse("alice"),
      endDefaultSession: false,
      endReason: "stop",
      expectedGeneration: null,
      sessionKey: SessionKey.parse("pane-1"),
    });
    expect(oldest.ended).toBe(0);
    const closed: CloseAgentResult = store.closeAgent({
      agentId: AgentId.parse("alice"),
      closeReason: "completed",
      expectedGeneration: null,
    });
    expect(closed.endedSessions).toBe(8);
  });
});

test("random session keys remain bounded while all live panes are preserved", (): void => {
  withLifecycle(({ path, store }: LifecycleFixture): void => {
    for (let index: number = 1; index <= 100; index += 1) {
      register(store, "alice", "mattpatagon/murmur", `pane-${index}`);
    }
    expect(requireAgent(store, "alice").liveSessionCount).toBe(8);
    store.close();
    const database: Database = new Database(path, { readonly: true });
    try {
      const row: unknown = database
        .query<unknown, [string]>(`
          SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE ended_at IS NULL) AS live
          FROM agent_sessions WHERE agent_id = ?
        `)
        .get("alice");
      if (row === null || typeof row !== "object") throw new Error("Expected session count");
      expect(Number(Reflect.get(row, "total"))).toBe(MAX_RETAINED_SESSIONS_PER_AGENT);
      expect(Number(Reflect.get(row, "live"))).toBe(8);
    } finally {
      database.close();
    }
  });
});

test("repository divergence waits for all live sessions before changing generation", (): void => {
  withLifecycle(({ clock, store }: LifecycleFixture): void => {
    const first: RegisterAgentResult = register(store, "alice", "owner/repo-a", "pane-a");
    const divergent: RegisterAgentResult = register(store, "alice", "owner/repo-b", "pane-b");
    expect(first.agent.generation.value).toBe(1);
    expect(divergent.repositoryDiverged).toBe(true);
    expect(divergent.agent.generation.value).toBe(1);
    expect(divergent.agent.metadata["repository"]).toBe("owner/repo-a");
    clock.set(Instant.parse("2026-01-01T01:00:00.000Z"));
    const switched: RegisterAgentResult = register(store, "alice", "owner/repo-b", "pane-c");
    expect(switched.repositoryDiverged).toBe(false);
    expect(switched.reopened).toBe(true);
    expect(switched.agent.generation.value).toBe(2);
    expect(switched.agent.metadata["repository"]).toBe("owner/repo-b");
  });
});

test("explicit closure isolates generations but stable idempotent retries return history", (): void => {
  withLifecycle(({ store }: LifecycleFixture): void => {
    register(store, "alice", "mattpatagon/murmur", "alice-pane");
    register(store, "bob", "mattpatagon/murmur", "bob-pane");
    const sent: SendMessageResult = store.sendMessage(messageCommand());
    const closed: CloseAgentResult = store.closeAgent({
      agentId: AgentId.parse("bob"),
      closeReason: "completed",
      expectedGeneration: AgentGeneration.parse(1),
    });
    expect(closed.unreadCount).toBe(1);
    const retry: SendMessageResult = store.sendMessage(messageCommand());
    expect(retry.duplicate).toBe(true);
    expect(retry.message.messageId.value).toBe(sent.message.messageId.value);
    expect(retry.recipientState).toBe("closed");
    expect((): SendMessageResult => store.sendMessage(messageCommand("new-closed-work"))).toThrow(
      "is closed",
    );

    const reopened: RegisterAgentResult = register(store, "bob", "mattpatagon/murmur", "new-pane");
    expect(reopened.agent.generation.value).toBe(2);
    expect(
      store.getMessages({
        afterSequence: Sequence.zero(),
        agentId: AgentId.parse("bob"),
        limit: 10,
        threadId: null,
        unreadOnly: false,
      }),
    ).toHaveLength(0);
    const history: readonly Message[] = store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      generation: AgentGeneration.parse(1),
      limit: 10,
      threadId: null,
      unreadOnly: false,
    });
    expect(history.map((message: Message): string => message.messageId.value)).toEqual([
      sent.message.messageId.value,
    ]);
  });
});

test("dormant same-repository return preserves generation and day-29 unread work", (): void => {
  withLifecycle(({ clock, store }: LifecycleFixture): void => {
    register(store, "alice", "mattpatagon/murmur", "alice-pane");
    register(store, "bob", "mattpatagon/murmur", "bob-pane");
    clock.set(Instant.parse("2026-01-30T00:00:00.000Z"));
    const sent: SendMessageResult = store.sendMessage(messageCommand("day-29"));
    clock.set(Instant.parse("2026-01-31T00:00:00.000Z"));
    store.pruneExpired(clock.now());
    expect(requireAgent(store, "bob").closeReason).toBe("dormant");
    clock.set(Instant.parse("2026-02-05T00:00:00.000Z"));
    const returned: RegisterAgentResult = register(
      store,
      "bob",
      "mattpatagon/murmur",
      "returned-pane",
    );
    expect(returned.agent.generation.value).toBe(1);
    const unread: readonly Message[] = store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      limit: 10,
      threadId: null,
      unreadOnly: true,
    });
    const unreadMessage: Message | undefined = unread[0];
    if (unreadMessage === undefined) {
      throw new Error("Expected dormant unread message");
    }
    expect(unreadMessage.messageId.value).toBe(sent.message.messageId.value);
  });
});

test("SQLite enforces the 1000-open-agent quota and closed rows release capacity", (): void => {
  withLifecycle(({ clock, path, store }: LifecycleFixture): void => {
    store.close();
    const database: Database = new Database(path);
    database.exec("BEGIN IMMEDIATE");
    const insert: Statement<unknown, [string, string, string, string]> = database.query(`
      INSERT INTO agents(agent_id, display_name, metadata_json, created_at, last_seen_at)
      VALUES (?, ?, '{}', ?, ?)
    `);
    for (let index: number = 0; index < 1_000; index += 1) {
      const id: string = `seed-${index}`;
      insert.run(id, id, clock.now().toISOString(), clock.now().toISOString());
    }
    database.exec("COMMIT");
    database.close();
    const reopened: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      expect((): RegisterAgentResult => register(reopened, "overflow", "owner/repo")).toThrow(
        "capacity",
      );
      reopened.closeAgent({
        agentId: AgentId.parse("seed-0"),
        closeReason: "manual",
        expectedGeneration: null,
      });
      expect(register(reopened, "replacement", "owner/repo").agent.state).toBe("active");
    } finally {
      reopened.close();
    }
  });
});
