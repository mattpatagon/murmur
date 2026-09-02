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
import { migrateSqliteDatabase } from "../src/storage/sqlite-message-migrations.js";
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
    expect(sent.message.client.value).toBe("connector");
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

test("upgrades populated SQLite v4 lifecycle and provenance rows", (): void => {
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
      VALUES
        (
          'legacy-active', 'Legacy active', '{"repository":"mattpatagon/murmur"}',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
        ),
        ('alice', 'Alice', '{}', '2026-08-04T11:00:00.000Z', '2026-08-04T11:00:00.000Z'),
        ('bob', 'Bob', '{}', '2026-08-04T11:00:00.000Z', '2026-08-04T11:00:00.000Z');
    INSERT INTO messages(
      message_id, thread_id, sender_id, recipient_id, content, repository_name,
      branch_name, client_name, idempotency_key, created_at, expires_at, read_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000004', 'legacy-v4-thread', 'alice', 'bob',
      'legacy v4 message', 'mattpatagon/murmur', 'feature/legacy', 'codex', NULL,
      '2026-08-04T11:45:00.000Z', '2026-09-03T11:45:00.000Z', NULL
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
    const alice: Agent | null = store.getAgent(AgentId.parse("alice"));
    if (alice === null) throw new Error("Expected migrated agent");
    expect(alice.authority).toBe("peer");
    const messages: readonly Message[] = store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse("bob"),
      limit: 100,
      threadId: null,
      unreadOnly: false,
    });
    const message: Message | undefined = messages[0];
    if (message === undefined) throw new Error("Expected migrated message");
    expect(message.senderAuthority).toBe("peer");
    expect(message.messageKind).toBe("message");
    expect(message.orchestratorPolicyId).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("upgrades a populated SQLite v8 database with bounded E2E tables and usage", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-store-v8-"));
  const databasePath: string = join(directory, "messages.db");
  const initial: SqliteMessageStore = new SqliteMessageStore(databasePath);
  initial.registerAgent({
    agentId: AgentId.parse("legacy-v8"),
    displayName: DisplayName.parse("Legacy v8"),
    metadata: { repository: "mattpatagon/murmur" },
  });
  initial.close();

  const legacyDatabase: Database = new Database(databasePath);
  legacyDatabase.exec(`
    DROP TABLE feedback_usage;
    DROP TABLE feedback_submissions;
    DROP TABLE e2ee_usage;
    DROP TABLE e2ee_messages;
    DROP TABLE e2ee_broadcast_deliveries;
    DROP TABLE e2ee_broadcasts;
    DROP TABLE e2ee_claims;
    DROP TABLE e2ee_prekeys;
    DROP TABLE e2ee_key_bundles;
    ALTER TABLE messages DROP COLUMN orchestrator_policy_id;
    ALTER TABLE messages DROP COLUMN message_kind;
    ALTER TABLE messages DROP COLUMN sender_authority;
    ALTER TABLE broadcasts DROP COLUMN sender_authority;
    ALTER TABLE agents DROP COLUMN authority;
    PRAGMA user_version = 8;
  `);
  legacyDatabase.close();

  const upgraded: SqliteMessageStore = new SqliteMessageStore(databasePath);
  try {
    expect(upgraded.getAgent(AgentId.parse("legacy-v8"))).not.toBeNull();
    const database: Database = new Database(databasePath, { readonly: true });
    try {
      const versionRow: unknown = database.query<unknown, []>("PRAGMA user_version").get();
      if (versionRow === null || typeof versionRow !== "object") {
        throw new Error("Expected SQLite schema version row");
      }
      expect(Number(Reflect.get(versionRow, "user_version"))).toBe(12);
      for (const table of ["messages", "broadcasts", "feedback_submissions"]) {
        const schemaRow: unknown = database
          .query<unknown, [string]>(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
          )
          .get(table);
        if (schemaRow === null || typeof schemaRow !== "object") {
          throw new Error("Expected upgraded SQLite table schema");
        }
        const sql: unknown = Reflect.get(schemaRow, "sql");
        expect(typeof sql === "string" ? sql : "").toContain("'connector'");
      }
      const usageRow: unknown = database
        .query<unknown, []>(`
          SELECT claim_count, pending_broadcast_count, retained_message_count
          FROM e2ee_usage WHERE singleton = 1
        `)
        .get();
      expect(usageRow).toEqual({
        claim_count: 0,
        pending_broadcast_count: 0,
        retained_message_count: 0,
      });
      expect(
        database
          .query<unknown, []>(`
            SELECT submission_count, content_bytes FROM feedback_usage WHERE singleton = 1
          `)
          .get(),
      ).toEqual({ content_bytes: 0, submission_count: 0 });
    } finally {
      database.close();
    }
  } finally {
    upgraded.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SQLite v12 migration rolls back invalid data and restores foreign keys", (): void => {
  const database: Database = new Database(":memory:", { create: true });
  try {
    migrateSqliteDatabase(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO messages(
        message_id, thread_id, sender_id, recipient_id, content, created_at, expires_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000099', 'invalid-foreign-key',
        'missing-sender', 'missing-recipient', 'invalid row',
        '2026-09-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'
      );
      PRAGMA user_version = 11;
    `);

    expect((): void => migrateSqliteDatabase(database)).toThrow(
      "SQLite migration violated a foreign key",
    );
    const versionRow: unknown = database.query<unknown, []>("PRAGMA user_version").get();
    const foreignKeysRow: unknown = database.query<unknown, []>("PRAGMA foreign_keys").get();
    if (typeof versionRow !== "object" || versionRow === null) {
      throw new Error("SQLite user version row is invalid");
    }
    if (typeof foreignKeysRow !== "object" || foreignKeysRow === null) {
      throw new Error("SQLite foreign-key row is invalid");
    }
    expect(Number(Reflect.get(versionRow, "user_version"))).toBe(11);
    expect(Number(Reflect.get(foreignKeysRow, "foreign_keys"))).toBe(1);
    expect(database.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
    expect((): void => {
      database.exec(`
          INSERT INTO messages(
            message_id, thread_id, sender_id, recipient_id, content, created_at, expires_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000100', 'foreign-key-restored',
            'missing-sender', 'missing-recipient', 'must fail',
            '2026-09-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'
          )
        `);
    }).toThrow("FOREIGN KEY constraint failed");
  } finally {
    database.close();
  }
});
