import type { Database, Statement } from "bun:sqlite";

import { type UserVersionRow, UserVersionRowSchema } from "./sqlite-message-rows.js";

const SUPPORTED_SCHEMA_VERSION: number = 7;

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
      version = 4;
    }
    if (version === 4) {
      database.exec(`
        ALTER TABLE agents ADD COLUMN generation INTEGER NOT NULL DEFAULT 1
          CHECK(generation >= 1);
        ALTER TABLE agents ADD COLUMN closed_at TEXT;
        ALTER TABLE agents ADD COLUMN close_reason TEXT
          CHECK(close_reason IS NULL OR close_reason IN (
            'completed', 'workspace_deleted', 'superseded', 'manual', 'dormant'
          ));
        CREATE TABLE agent_sessions (
          agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          session_key TEXT NOT NULL CHECK(
            length(session_key) BETWEEN 1 AND 64
            AND session_key NOT GLOB '*[^A-Za-z0-9._-]*'
          ),
          started_at TEXT NOT NULL,
          last_renewed_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT CHECK(end_reason IS NULL OR end_reason IN (
            'stop', 'session_end', 'superseded', 'expired', 'closed'
          )),
          PRIMARY KEY(agent_id, generation, session_key)
        );
        CREATE INDEX agent_sessions_live_lease
          ON agent_sessions(agent_id, generation, ended_at, lease_expires_at);
        CREATE INDEX agents_open_activity
          ON agents(closed_at, last_seen_at DESC, agent_id);
        INSERT INTO agent_sessions(
          agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at
        )
        SELECT
          agent_id,
          1,
          'backfill',
          last_seen_at,
          last_seen_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at, '+60 minutes')
        FROM agents
        WHERE last_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 minutes');
        PRAGMA user_version = 5;
      `);
      version = 5;
    }
    if (version === 5) {
      database.exec(`
        ALTER TABLE messages ADD COLUMN sender_generation INTEGER NOT NULL DEFAULT 1
          CHECK(sender_generation >= 1);
        ALTER TABLE messages ADD COLUMN recipient_generation INTEGER NOT NULL DEFAULT 1
          CHECK(recipient_generation >= 1);
        ALTER TABLE broadcasts ADD COLUMN sender_generation INTEGER NOT NULL DEFAULT 1
          CHECK(sender_generation >= 1);
        CREATE INDEX messages_recipient_generation_sequence
          ON messages(recipient_id, recipient_generation, sequence);
        PRAGMA user_version = 6;
      `);
      version = 6;
    }
    if (version === 6) {
      database.exec(`
        CREATE TABLE notices (
          notice_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('handoff', 'ownership', 'blocker', 'decision')),
          creator_id TEXT NOT NULL CHECK(
            length(creator_id) BETWEEN 1 AND 200
            AND creator_id GLOB '[A-Za-z0-9]*'
            AND creator_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          ),
          creator_generation INTEGER NOT NULL CHECK(creator_generation >= 1),
          repository_name TEXT NOT NULL,
          branch_name TEXT,
          content TEXT NOT NULL,
          idempotency_key TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          resolved_by_id TEXT CHECK(resolved_by_id IS NULL OR (
            length(resolved_by_id) BETWEEN 1 AND 200
            AND resolved_by_id GLOB '[A-Za-z0-9]*'
            AND resolved_by_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          )),
          resolved_by_generation INTEGER CHECK(resolved_by_generation IS NULL OR resolved_by_generation >= 1),
          resolved_at TEXT,
          withdrawn_by_id TEXT CHECK(withdrawn_by_id IS NULL OR (
            length(withdrawn_by_id) BETWEEN 1 AND 200
            AND withdrawn_by_id GLOB '[A-Za-z0-9]*'
            AND withdrawn_by_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          )),
          withdrawn_by_generation INTEGER CHECK(withdrawn_by_generation IS NULL OR withdrawn_by_generation >= 1),
          withdrawn_at TEXT,
          resolution_note TEXT,
          UNIQUE(creator_id, idempotency_key),
          CHECK((resolved_at IS NULL) = (resolved_by_id IS NULL)),
          CHECK((withdrawn_at IS NULL) = (withdrawn_by_id IS NULL)),
          CHECK(NOT (resolved_at IS NOT NULL AND withdrawn_at IS NOT NULL))
        );
        CREATE INDEX notices_repository_state
          ON notices(repository_name, resolved_at, withdrawn_at, expires_at, created_at DESC);
        CREATE INDEX notices_expiration ON notices(expires_at);
        PRAGMA user_version = 7;
      `);
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
