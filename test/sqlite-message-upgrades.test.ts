import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Agent,
  Message,
  SendMessageCommand,
  SendMessageResult,
} from "../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  IdempotencyKey,
  MessageContent,
  Sequence,
} from "../src/domain/value-objects.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { baseMessageCommand } from "./support/store-fixture.js";

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

test("upgrades a populated SQLite v4 agent with a live compatibility lease", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-store-v4-"));
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
    CREATE TABLE broadcasts (
      broadcast_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES agents(agent_id),
      content TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      client_name TEXT NOT NULL CHECK(client_name IN ('claude', 'codex')),
      audience_repository_name TEXT,
      audience_machine_name TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(sender_id, idempotency_key)
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES agents(agent_id),
      recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
      broadcast_id TEXT REFERENCES broadcasts(broadcast_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      repository_name TEXT,
      branch_name TEXT CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 500),
      client_name TEXT CHECK(client_name IS NULL OR client_name IN ('claude', 'codex')),
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      read_at TEXT,
      UNIQUE(sender_id, idempotency_key)
    );
    INSERT INTO agents(agent_id, display_name, metadata_json, created_at, last_seen_at)
    VALUES (
      'legacy-active', 'Legacy active', '{"repository":"mattpatagon/murmur"}',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
    );
    PRAGMA user_version = 4;
  `);
  legacyDatabase.close();

  const store: SqliteMessageStore = new SqliteMessageStore(databasePath);
  try {
    const agent: Agent | null = store.getAgent(AgentId.parse("legacy-active"));
    if (agent === null) throw new Error("Expected migrated agent");
    expect(agent.generation.value).toBe(1);
    expect(agent.state).toBe("active");
    expect(agent.liveSessionCount).toBe(1);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
