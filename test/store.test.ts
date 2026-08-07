import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { RETENTION_DAYS } from "../src/domain/contracts.js";
import type {
  MarkMessagesReadResult,
  Message,
  SendMessageCommand,
  SendMessageResult,
} from "../src/domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  DisplayName,
  IdempotencyKey,
  type Clock,
  Instant,
  MessageContent,
  MessageId,
  RepositoryName,
  Sequence,
} from "../src/domain/value-objects.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

class MutableClock implements Clock {
  private current: Instant;

  public constructor(initial: Instant) {
    this.current = initial;
  }

  public now(): Instant {
    return this.current;
  }

  public set(instant: Instant): void {
    this.current = instant;
  }
}

type StoreFixture = {
  readonly clock: MutableClock;
  readonly store: SqliteMessageStore;
};

function withFixture(run: (fixture: StoreFixture) => void): void {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-store-"));
  const clock: MutableClock = new MutableClock(Instant.parse("2026-08-04T12:00:00.000Z"));
  const store: SqliteMessageStore = new SqliteMessageStore(join(directory, "messages.db"), clock);
  try {
    store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("Alice"),
      metadata: {},
    });
    store.registerAgent({
      agentId: AgentId.parse("bob"),
      displayName: DisplayName.parse("Bob"),
      metadata: {},
    });
    run({ clock, store });
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function baseMessageCommand(): SendMessageCommand {
  return {
    branchName: BranchName.parse("feature/agent-context"),
    client: AgentClient.parse("codex"),
    content: MessageContent.parse("Can you review this?"),
    idempotencyKey: IdempotencyKey.parse("review-1"),
    recipientId: AgentId.parse("bob"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    senderId: AgentId.parse("alice"),
    threadId: null,
  };
}

test("stores, reads, and marks an inbox message", (): void => {
  withFixture((fixture: StoreFixture): void => {
    const sent: SendMessageResult = fixture.store.sendMessage(baseMessageCommand());
    expect(sent.duplicate).toBe(false);
    expect(sent.message.senderId.value).toBe("alice");
    expect(sent.message.recipientId.value).toBe("bob");
    if (sent.message.branchName === null) throw new Error("Expected branch context");
    expect(sent.message.branchName.value).toBe("feature/agent-context");
    if (sent.message.client === null) throw new Error("Expected client context");
    expect(sent.message.client.value).toBe("codex");
    if (sent.message.repositoryName === null) throw new Error("Expected repository context");
    expect(sent.message.repositoryName.value).toBe("mattpatagon/murmur");
    expect(sent.message.createdAt.toISOString()).toBe("2026-08-04T12:00:00.000Z");
    expect(fixture.store.getInboxVersion(AgentId.parse("bob")).value).toBe(
      sent.message.sequence.value,
    );

    const unread: readonly Message[] = fixture.store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      limit: 100,
      threadId: null,
      unreadOnly: true,
    });
    expect(unread.map((message: Message): string => message.messageId.value)).toEqual([
      sent.message.messageId.value,
    ]);

    const wrongRecipient: MarkMessagesReadResult = fixture.store.markMessagesRead({
      agentId: AgentId.parse("alice"),
      messageIds: [sent.message.messageId],
    });
    expect(wrongRecipient.updated).toBe(0);

    const marked: MarkMessagesReadResult = fixture.store.markMessagesRead({
      agentId: AgentId.parse("bob"),
      messageIds: [sent.message.messageId],
    });
    expect(marked.updated).toBe(1);
    const remaining: readonly Message[] = fixture.store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      limit: 100,
      threadId: null,
      unreadOnly: true,
    });
    expect(remaining).toEqual([]);
  });
});

test("deduplicates retries and rejects idempotency-key reuse", (): void => {
  withFixture((fixture: StoreFixture): void => {
    const command: SendMessageCommand = baseMessageCommand();
    const first: SendMessageResult = fixture.store.sendMessage(command);
    const retry: SendMessageResult = fixture.store.sendMessage(command);
    expect(retry.duplicate).toBe(true);
    expect(retry.message.messageId.equals(first.message.messageId)).toBe(true);

    const conflicting: SendMessageCommand = {
      ...command,
      content: MessageContent.parse("different request"),
    };
    expect((): SendMessageResult => fixture.store.sendMessage(conflicting)).toThrow(
      "already used for a different message",
    );

    const repositoryConflict: SendMessageCommand = {
      ...command,
      repositoryName: RepositoryName.parse("another/repository"),
    };
    expect((): SendMessageResult => fixture.store.sendMessage(repositoryConflict)).toThrow(
      "already used for a different message",
    );

    const branchConflict: SendMessageCommand = {
      ...command,
      branchName: BranchName.parse("feature/another-branch"),
    };
    expect((): SendMessageResult => fixture.store.sendMessage(branchConflict)).toThrow(
      "already used for a different message",
    );

    const clientConflict: SendMessageCommand = {
      ...command,
      client: AgentClient.parse("claude"),
    };
    expect((): SendMessageResult => fixture.store.sendMessage(clientConflict)).toThrow(
      "already used for a different message",
    );
  });
});

test(`persists messages for ${RETENTION_DAYS} days, then expires them`, (): void => {
  withFixture((fixture: StoreFixture): void => {
    const sent: SendMessageResult = fixture.store.sendMessage(baseMessageCommand());
    const retentionMilliseconds: number =
      sent.message.expiresAt.toEpochMilliseconds() - sent.message.createdAt.toEpochMilliseconds();
    expect(retentionMilliseconds).toBe(RETENTION_DAYS * 24 * 60 * 60 * 1000);

    fixture.clock.set(Instant.parse("2026-09-03T11:59:59.999Z"));
    expect(fixture.store.pruneExpired(fixture.clock.now())).toBe(0);
    fixture.clock.set(Instant.parse("2026-09-03T12:00:00.000Z"));
    expect(fixture.store.pruneExpired(fixture.clock.now())).toBe(1);
  });
});

test("requires both agents to register", (): void => {
  withFixture((fixture: StoreFixture): void => {
    const command: SendMessageCommand = {
      branchName: null,
      client: null,
      content: MessageContent.parse("hello"),
      idempotencyKey: null,
      recipientId: AgentId.parse("carol"),
      repositoryName: null,
      senderId: AgentId.parse("alice"),
      threadId: null,
    };
    expect((): SendMessageResult => fixture.store.sendMessage(command)).toThrow(
      "Unknown agent 'carol'",
    );
  });
});

test("upgrades an existing SQLite schema before storing message context", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-store-v1-"));
  const databasePath: string = join(directory, "messages.db");
  const legacyDatabase: Database = new Database(databasePath, { create: true });
  legacyDatabase.exec(`
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES agents(agent_id),
      recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
      content TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      read_at TEXT,
      UNIQUE(sender_id, idempotency_key)
    );
    INSERT INTO agents(agent_id, display_name, metadata_json, created_at, last_seen_at)
      VALUES
        ('alice', 'Alice', '{}', '2026-08-04T11:00:00.000Z', '2026-08-04T11:00:00.000Z'),
        ('bob', 'Bob', '{}', '2026-08-04T11:00:00.000Z', '2026-08-04T11:00:00.000Z');
    INSERT INTO messages(
      message_id, thread_id, sender_id, recipient_id, content,
      idempotency_key, created_at, expires_at, read_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000001', 'legacy-thread', 'alice', 'bob',
      'legacy message', 'legacy-key', '2026-08-04T11:30:00.000Z',
      '2026-09-03T11:30:00.000Z', NULL
    );
    PRAGMA user_version = 1;
  `);
  legacyDatabase.close();

  const store: SqliteMessageStore = new SqliteMessageStore(databasePath);
  try {
    store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("Alice"),
      metadata: {},
    });
    store.registerAgent({
      agentId: AgentId.parse("bob"),
      displayName: DisplayName.parse("Bob"),
      metadata: {},
    });
    const legacyMessages: readonly Message[] = store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      limit: 100,
      threadId: null,
      unreadOnly: false,
    });
    const legacyMessage: Message | undefined = legacyMessages[0];
    if (legacyMessage === undefined) throw new Error("Expected the legacy message");
    expect(legacyMessage.repositoryName).toBeNull();
    expect(legacyMessage.branchName).toBeNull();
    expect(legacyMessage.client).toBeNull();
    expect(legacyMessage.createdAt.toISOString()).toBe("2026-08-04T11:30:00.000Z");

    const legacyRetry: SendMessageCommand = {
      ...baseMessageCommand(),
      content: MessageContent.parse("legacy message"),
      idempotencyKey: IdempotencyKey.parse("legacy-key"),
      threadId: legacyMessage.threadId,
    };
    expect((): SendMessageResult => store.sendMessage(legacyRetry)).toThrow(
      "already used for a different message",
    );

    const sent: SendMessageResult = store.sendMessage(baseMessageCommand());
    if (sent.message.branchName === null) throw new Error("Expected branch context");
    expect(sent.message.branchName.value).toBe("feature/agent-context");
    if (sent.message.client === null) throw new Error("Expected client context");
    expect(sent.message.client.value).toBe("codex");
    if (sent.message.repositoryName === null) throw new Error("Expected repository context");
    expect(sent.message.repositoryName.value).toBe("mattpatagon/murmur");
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("upgrades a SQLite v2 message while preserving repository context", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-store-v2-"));
  const databasePath: string = join(directory, "messages.db");
  const legacyDatabase: Database = new Database(databasePath, { create: true });
  legacyDatabase.exec(`
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES agents(agent_id),
      recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
      content TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      read_at TEXT,
      repository_name TEXT,
      UNIQUE(sender_id, idempotency_key)
    );
    INSERT INTO agents(agent_id, display_name, metadata_json, created_at, last_seen_at)
      VALUES
        ('alice', 'Alice', '{}', '2026-08-04T11:00:00.000Z', '2026-08-04T11:00:00.000Z'),
        ('bob', 'Bob', '{}', '2026-08-04T11:00:00.000Z', '2026-08-04T11:00:00.000Z');
    INSERT INTO messages(
      message_id, thread_id, sender_id, recipient_id, content,
      idempotency_key, created_at, expires_at, read_at, repository_name
    ) VALUES (
      '00000000-0000-4000-8000-000000000002', 'legacy-v2-thread', 'alice', 'bob',
      'legacy v2 message', NULL, '2026-08-04T11:45:00.000Z',
      '2026-09-03T11:45:00.000Z', NULL, 'mattpatagon/murmur'
    );
    PRAGMA user_version = 2;
  `);
  legacyDatabase.close();

  const store: SqliteMessageStore = new SqliteMessageStore(databasePath);
  try {
    const legacyMessages: readonly Message[] = store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      limit: 100,
      threadId: null,
      unreadOnly: false,
    });
    const legacyMessage: Message | undefined = legacyMessages[0];
    if (legacyMessage === undefined) throw new Error("Expected the v2 message");
    if (legacyMessage.repositoryName === null) throw new Error("Expected repository context");
    expect(legacyMessage.repositoryName.value).toBe("mattpatagon/murmur");
    expect(legacyMessage.branchName).toBeNull();
    expect(legacyMessage.client).toBeNull();
    expect(legacyMessage.createdAt.toISOString()).toBe("2026-08-04T11:45:00.000Z");
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects malformed domain identifiers before storage", (): void => {
  expect((): AgentClient => AgentClient.parse("cursor")).toThrow();
  expect((): AgentId => AgentId.parse("space is not allowed")).toThrow();
  expect((): BranchName => BranchName.parse("")).toThrow();
  expect((): MessageId => MessageId.parse("not-a-uuid")).toThrow();
  expect((): RepositoryName => RepositoryName.parse("missing-slash")).toThrow();
});
