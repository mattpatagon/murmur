import type { Database, Statement } from "bun:sqlite";

import { migrateSqliteClientNames } from "./sqlite-client-name-migration.js";
import { migrateSqliteClientSlugs } from "./sqlite-client-slug-migration.js";
import { type UserVersionRow, UserVersionRowSchema } from "./sqlite-message-rows.js";

const SUPPORTED_SCHEMA_VERSION: number = 13;

function schemaVersion(database: Database): number {
  const statement: Statement<unknown, []> = database.query("PRAGMA user_version");
  const row: UserVersionRow = UserVersionRowSchema.parse(statement.get());
  return row.user_version;
}

export function migrateSqliteDatabase(database: Database): void {
  database.exec("PRAGMA foreign_keys = OFF");
  let transactionStarted: boolean = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
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
        CREATE INDEX agent_sessions_ended_cleanup
          ON agent_sessions(ended_at, agent_id, generation, session_key)
          WHERE ended_at IS NOT NULL;
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
        CREATE INDEX notices_creator_agent ON notices(creator_id);
        CREATE INDEX notices_resolver_agent ON notices(resolved_by_id)
          WHERE resolved_by_id IS NOT NULL;
        CREATE INDEX notices_withdrawer_agent ON notices(withdrawn_by_id)
          WHERE withdrawn_by_id IS NOT NULL;
        PRAGMA user_version = 7;
      `);
      version = 7;
    }
    if (version === 7) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS agent_sessions_ended_cleanup
          ON agent_sessions(ended_at, agent_id, generation, session_key)
          WHERE ended_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS notices_creator_agent ON notices(creator_id);
        CREATE INDEX IF NOT EXISTS notices_resolver_agent ON notices(resolved_by_id)
          WHERE resolved_by_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS notices_withdrawer_agent ON notices(withdrawn_by_id)
          WHERE withdrawn_by_id IS NOT NULL;
        PRAGMA user_version = 8;
      `);
      version = 8;
    }
    if (version === 8) {
      database.exec(`
        CREATE TABLE e2ee_key_bundles (
          agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
          agent_generation INTEGER NOT NULL CHECK(agent_generation >= 1),
          root_key_id TEXT NOT NULL,
          agent_key_id TEXT NOT NULL UNIQUE,
          bundle_json TEXT NOT NULL,
          published_at TEXT NOT NULL
        );
        CREATE TABLE e2ee_prekeys (
          prekey_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
          agent_generation INTEGER NOT NULL CHECK(agent_generation >= 1),
          prekey_class TEXT NOT NULL CHECK(prekey_class IN ('fallback', 'one_time')),
          certificate_json TEXT NOT NULL,
          published_at TEXT NOT NULL,
          retired_at TEXT,
          claimed_at TEXT,
          CHECK(prekey_class = 'one_time' OR claimed_at IS NULL)
        );
        CREATE INDEX e2ee_prekeys_available
          ON e2ee_prekeys(agent_id, agent_generation, prekey_class, claimed_at, retired_at, prekey_id);
        CREATE TABLE e2ee_claims (
          claim_id TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL REFERENCES agents(agent_id),
          sender_generation INTEGER NOT NULL CHECK(sender_generation >= 1),
          recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
          recipient_generation INTEGER NOT NULL CHECK(recipient_generation >= 1),
          prekey_id TEXT NOT NULL REFERENCES e2ee_prekeys(prekey_id),
          prekey_class TEXT NOT NULL CHECK(prekey_class IN ('fallback', 'one_time')),
          request_json TEXT NOT NULL,
          claim_json TEXT NOT NULL,
          broadcast_id TEXT,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX e2ee_claims_expiration ON e2ee_claims(expires_at, consumed_at);
        CREATE INDEX e2ee_claims_broadcast ON e2ee_claims(broadcast_id, recipient_id);
        CREATE TABLE e2ee_broadcasts (
          broadcast_id TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL REFERENCES agents(agent_id),
          sender_generation INTEGER NOT NULL CHECK(sender_generation >= 1),
          thread_id TEXT NOT NULL,
          audience_repository_name TEXT,
          audience_machine_name TEXT,
          idempotency_key TEXT,
          request_json TEXT NOT NULL,
          recipient_count INTEGER NOT NULL CHECK(recipient_count BETWEEN 0 AND 100),
          state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'cancelled')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          committed_at TEXT,
          UNIQUE(sender_id, idempotency_key)
        );
        CREATE INDEX e2ee_broadcasts_expiration ON e2ee_broadcasts(expires_at, state);
        CREATE TABLE e2ee_broadcast_deliveries (
          broadcast_id TEXT NOT NULL REFERENCES e2ee_broadcasts(broadcast_id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
          recipient_generation INTEGER NOT NULL CHECK(recipient_generation >= 1),
          claim_id TEXT NOT NULL UNIQUE REFERENCES e2ee_claims(claim_id),
          envelope_json TEXT,
          sender_chain_json TEXT,
          ciphertext_bytes INTEGER CHECK(ciphertext_bytes IS NULL OR ciphertext_bytes > 0),
          accepted_at TEXT,
          PRIMARY KEY(broadcast_id, recipient_id),
          CHECK((envelope_json IS NULL) = (accepted_at IS NULL)),
          CHECK((sender_chain_json IS NULL) = (accepted_at IS NULL)),
          CHECK((ciphertext_bytes IS NULL) = (accepted_at IS NULL))
        );
        CREATE TABLE e2ee_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          thread_id TEXT NOT NULL,
          sender_id TEXT NOT NULL REFERENCES agents(agent_id),
          sender_generation INTEGER NOT NULL CHECK(sender_generation >= 1),
          recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
          recipient_generation INTEGER NOT NULL CHECK(recipient_generation >= 1),
          broadcast_id TEXT,
          idempotency_key TEXT NOT NULL,
          pair_counter INTEGER NOT NULL CHECK(pair_counter >= 1),
          envelope_json TEXT NOT NULL,
          sender_chain_json TEXT NOT NULL,
          ciphertext_bytes INTEGER NOT NULL CHECK(ciphertext_bytes > 0),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          read_at TEXT,
          UNIQUE(sender_id, idempotency_key),
          UNIQUE(sender_id, recipient_id, pair_counter)
        );
        CREATE INDEX e2ee_messages_recipient_sequence
          ON e2ee_messages(recipient_id, recipient_generation, sequence);
        CREATE INDEX e2ee_messages_recipient_unread
          ON e2ee_messages(recipient_id, recipient_generation, read_at, sequence);
        CREATE INDEX e2ee_messages_thread_sequence ON e2ee_messages(thread_id, sequence);
        CREATE INDEX e2ee_messages_expiration ON e2ee_messages(expires_at);
        CREATE INDEX e2ee_messages_broadcast_recipient
          ON e2ee_messages(broadcast_id, recipient_id);
        CREATE TABLE e2ee_usage (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count >= 0),
          pending_broadcast_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_broadcast_count >= 0),
          pending_ciphertext_bytes INTEGER NOT NULL DEFAULT 0 CHECK(pending_ciphertext_bytes >= 0),
          pending_delivery_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_delivery_count >= 0),
          public_prekey_count INTEGER NOT NULL DEFAULT 0 CHECK(public_prekey_count >= 0),
          retained_ciphertext_bytes INTEGER NOT NULL DEFAULT 0 CHECK(retained_ciphertext_bytes >= 0),
          retained_message_count INTEGER NOT NULL DEFAULT 0 CHECK(retained_message_count >= 0)
        );
        INSERT INTO e2ee_usage(singleton) VALUES (1);
        ALTER TABLE agents ADD COLUMN authority TEXT NOT NULL DEFAULT 'peer'
          CHECK(authority = 'peer');
        ALTER TABLE broadcasts ADD COLUMN sender_authority TEXT NOT NULL DEFAULT 'peer'
          CHECK(sender_authority = 'peer');
        ALTER TABLE messages ADD COLUMN sender_authority TEXT NOT NULL DEFAULT 'peer'
          CHECK(sender_authority = 'peer');
        ALTER TABLE messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'message'
          CHECK(message_kind = 'message');
        ALTER TABLE messages ADD COLUMN orchestrator_policy_id TEXT
          CHECK(orchestrator_policy_id IS NULL);
        PRAGMA user_version = 9;
      `);
      version = 9;
    }
    if (version === 9) {
      database.exec(`
        ALTER TABLE e2ee_broadcasts ADD COLUMN sender_authority TEXT NOT NULL DEFAULT 'peer'
          CHECK(sender_authority IN ('peer', 'orchestrator'));
        PRAGMA user_version = 10;
      `);
      version = 10;
    }
    if (version === 10) {
      database.exec(`
        CREATE TABLE feedback_submissions (
          feedback_id TEXT PRIMARY KEY,
          submission_type TEXT NOT NULL
            CHECK(submission_type IN ('issue', 'feature_request')),
          reporter_id TEXT NOT NULL
            CHECK(
              length(reporter_id) BETWEEN 1 AND 200
              AND substr(reporter_id, 1, 1) GLOB '[A-Za-z0-9]'
              AND reporter_id NOT GLOB '*[^A-Za-z0-9._:-]*'
            ),
          reporter_generation INTEGER NOT NULL CHECK(reporter_generation >= 1),
          repository_name TEXT NOT NULL
            CHECK(
              length(repository_name) BETWEEN 3 AND 500
              AND repository_name GLOB '*/*'
              AND repository_name NOT GLOB '*[^A-Za-z0-9._/-]*'
              AND substr(repository_name, 1, 1) <> '/'
              AND substr(repository_name, -1, 1) <> '/'
              AND instr(repository_name, '//') = 0
            ),
          branch_name TEXT NOT NULL CHECK(length(branch_name) BETWEEN 1 AND 500),
          client_name TEXT NOT NULL CHECK(client_name IN ('claude', 'codex')),
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
          description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 100000),
          idempotency_key TEXT CHECK(
            idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200
          ),
          created_at TEXT NOT NULL,
          UNIQUE(reporter_id, idempotency_key)
        );
        CREATE INDEX feedback_submissions_created
          ON feedback_submissions(created_at DESC, feedback_id);
        CREATE INDEX feedback_submissions_type_created
          ON feedback_submissions(submission_type, created_at DESC, feedback_id);
        CREATE INDEX feedback_submissions_reporter
          ON feedback_submissions(reporter_id);
        CREATE TABLE feedback_usage (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          submission_count INTEGER NOT NULL DEFAULT 0
            CHECK(submission_count BETWEEN 0 AND 10000),
          content_bytes INTEGER NOT NULL DEFAULT 0
            CHECK(content_bytes BETWEEN 0 AND 67108864)
        );
        INSERT INTO feedback_usage(singleton) VALUES (1);
        PRAGMA user_version = 11;
      `);
      version = 11;
    }
    if (version === 11) {
      migrateSqliteClientNames(database);
      database.exec("PRAGMA user_version = 12");
      version = 12;
    }
    if (version === 12) {
      migrateSqliteClientSlugs(database);
      database.exec("PRAGMA user_version = 13");
    }
    const foreignKeyViolation: unknown = database.query("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation !== null) throw new Error("SQLite migration violated a foreign key");
    database.exec("COMMIT");
    transactionStarted = false;
  } catch (error: unknown) {
    if (transactionStarted) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
