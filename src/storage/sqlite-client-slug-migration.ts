import type { Database } from "bun:sqlite";

export function migrateSqliteClientSlugs(database: Database): void {
  database.exec(`
    CREATE TABLE broadcasts_v13 (
      broadcast_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES agents(agent_id),
      content TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      client_name TEXT NOT NULL CHECK(
        length(client_name) BETWEEN 1 AND 32
        AND substr(client_name, 1, 1) GLOB '[a-z]'
        AND client_name NOT GLOB '*[^a-z0-9-]*'
      ),
      audience_repository_name TEXT,
      audience_machine_name TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      sender_generation INTEGER NOT NULL DEFAULT 1 CHECK(sender_generation >= 1),
      sender_authority TEXT NOT NULL DEFAULT 'peer' CHECK(sender_authority = 'peer'),
      UNIQUE(sender_id, idempotency_key)
    );
    INSERT INTO broadcasts_v13(
      broadcast_id, thread_id, sender_id, content, repository_name, branch_name, client_name,
      audience_repository_name, audience_machine_name, idempotency_key, created_at, expires_at,
      sender_generation, sender_authority
    )
    SELECT
      broadcast_id, thread_id, sender_id, content, repository_name, branch_name, client_name,
      audience_repository_name, audience_machine_name, idempotency_key, created_at, expires_at,
      sender_generation, sender_authority
    FROM broadcasts;

    CREATE TABLE messages_v13 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES agents(agent_id),
      recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
      broadcast_id TEXT REFERENCES broadcasts(broadcast_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      repository_name TEXT,
      branch_name TEXT CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 500),
      client_name TEXT CHECK(
        client_name IS NULL OR (
          length(client_name) BETWEEN 1 AND 32
          AND substr(client_name, 1, 1) GLOB '[a-z]'
          AND client_name NOT GLOB '*[^a-z0-9-]*'
        )
      ),
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      read_at TEXT,
      sender_generation INTEGER NOT NULL DEFAULT 1 CHECK(sender_generation >= 1),
      recipient_generation INTEGER NOT NULL DEFAULT 1 CHECK(recipient_generation >= 1),
      sender_authority TEXT NOT NULL DEFAULT 'peer' CHECK(sender_authority = 'peer'),
      message_kind TEXT NOT NULL DEFAULT 'message' CHECK(message_kind = 'message'),
      orchestrator_policy_id TEXT CHECK(orchestrator_policy_id IS NULL),
      UNIQUE(sender_id, idempotency_key)
    );
    INSERT INTO messages_v13(
      sequence, message_id, thread_id, sender_id, recipient_id, broadcast_id, content,
      repository_name, branch_name, client_name, idempotency_key, created_at, expires_at,
      read_at, sender_generation, recipient_generation, sender_authority, message_kind,
      orchestrator_policy_id
    )
    SELECT
      sequence, message_id, thread_id, sender_id, recipient_id, broadcast_id, content,
      repository_name, branch_name, client_name, idempotency_key, created_at, expires_at,
      read_at, sender_generation, recipient_generation, sender_authority, message_kind,
      orchestrator_policy_id
    FROM messages;

    CREATE TABLE feedback_submissions_v13 (
      feedback_id TEXT PRIMARY KEY,
      submission_type TEXT NOT NULL CHECK(submission_type IN ('issue', 'feature_request')),
      reporter_id TEXT NOT NULL CHECK(
        length(reporter_id) BETWEEN 1 AND 200
        AND substr(reporter_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND reporter_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      reporter_generation INTEGER NOT NULL CHECK(reporter_generation >= 1),
      repository_name TEXT NOT NULL CHECK(
        length(repository_name) BETWEEN 3 AND 500
        AND repository_name GLOB '*/*'
        AND repository_name NOT GLOB '*[^A-Za-z0-9._/-]*'
        AND substr(repository_name, 1, 1) <> '/'
        AND substr(repository_name, -1, 1) <> '/'
        AND instr(repository_name, '//') = 0
      ),
      branch_name TEXT NOT NULL CHECK(length(branch_name) BETWEEN 1 AND 500),
      client_name TEXT NOT NULL CHECK(
        length(client_name) BETWEEN 1 AND 32
        AND substr(client_name, 1, 1) GLOB '[a-z]'
        AND client_name NOT GLOB '*[^a-z0-9-]*'
      ),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 100000),
      idempotency_key TEXT CHECK(
        idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200
      ),
      created_at TEXT NOT NULL,
      UNIQUE(reporter_id, idempotency_key)
    );
    INSERT INTO feedback_submissions_v13(
      feedback_id, submission_type, reporter_id, reporter_generation, repository_name,
      branch_name, client_name, title, description, idempotency_key, created_at
    )
    SELECT
      feedback_id, submission_type, reporter_id, reporter_generation, repository_name,
      branch_name, client_name, title, description, idempotency_key, created_at
    FROM feedback_submissions;

    DROP TABLE messages;
    DROP TABLE broadcasts;
    DROP TABLE feedback_submissions;
    ALTER TABLE broadcasts_v13 RENAME TO broadcasts;
    ALTER TABLE messages_v13 RENAME TO messages;
    ALTER TABLE feedback_submissions_v13 RENAME TO feedback_submissions;

    CREATE INDEX broadcasts_expiration ON broadcasts(expires_at);
    CREATE INDEX messages_recipient_sequence ON messages(recipient_id, sequence);
    CREATE INDEX messages_recipient_unread ON messages(recipient_id, read_at, sequence);
    CREATE INDEX messages_thread_sequence ON messages(thread_id, sequence);
    CREATE INDEX messages_expiration ON messages(expires_at);
    CREATE INDEX messages_broadcast_recipient ON messages(broadcast_id, recipient_id);
    CREATE INDEX messages_recipient_generation_sequence
      ON messages(recipient_id, recipient_generation, sequence);
    CREATE INDEX feedback_submissions_created
      ON feedback_submissions(created_at DESC, feedback_id);
    CREATE INDEX feedback_submissions_type_created
      ON feedback_submissions(submission_type, created_at DESC, feedback_id);
    CREATE INDEX feedback_submissions_reporter ON feedback_submissions(reporter_id);
  `);
}
