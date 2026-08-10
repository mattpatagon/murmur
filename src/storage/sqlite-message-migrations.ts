import type { Database, Statement } from "bun:sqlite";

import { type UserVersionRow, UserVersionRowSchema } from "./sqlite-message-rows.js";

const SUPPORTED_SCHEMA_VERSION: number = 4;

function schemaVersion(database: Database): number {
  const statement: Statement<unknown, []> = database.query("PRAGMA user_version");
  const row: UserVersionRow = UserVersionRowSchema.parse(statement.get());
  return row.user_version;
}

export function migrateSqliteDatabase(database: Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    let version: number = schemaVersion(database);
    if (version > SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than this Murmur build supports`,
      );
    }
    if (version === 0) {
      database.exec(`
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

        CREATE INDEX messages_recipient_sequence ON messages(recipient_id, sequence);
        CREATE INDEX messages_recipient_unread ON messages(recipient_id, read_at, sequence);
        CREATE INDEX messages_thread_sequence ON messages(thread_id, sequence);
        CREATE INDEX messages_expiration ON messages(expires_at);
        CREATE INDEX messages_broadcast_recipient ON messages(broadcast_id, recipient_id);
        CREATE INDEX broadcasts_expiration ON broadcasts(expires_at);

        PRAGMA user_version = 4;
      `);
      version = 4;
    }
    if (version === 1) {
      database.exec(`
        ALTER TABLE messages ADD COLUMN repository_name TEXT;
        PRAGMA user_version = 2;
      `);
      version = 2;
    }
    if (version === 2) {
      database.exec(`
        ALTER TABLE messages ADD COLUMN branch_name TEXT
          CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 500);
        ALTER TABLE messages ADD COLUMN client_name TEXT
          CHECK(client_name IS NULL OR client_name IN ('claude', 'codex'));
        PRAGMA user_version = 3;
      `);
      version = 3;
    }
    if (version === 3) {
      database.exec(`
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
        CREATE INDEX broadcasts_expiration ON broadcasts(expires_at);
        ALTER TABLE messages ADD COLUMN broadcast_id TEXT
          REFERENCES broadcasts(broadcast_id) ON DELETE CASCADE;
        CREATE INDEX messages_broadcast_recipient ON messages(broadcast_id, recipient_id);
        PRAGMA user_version = 4;
      `);
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
