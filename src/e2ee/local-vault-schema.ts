import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

const VAULT_SCHEMA_VERSION: number = 10;
const UserVersionRowSchema: z.ZodType<{ readonly user_version: number }> = z.object({
  user_version: z
    .union([z.number().int(), z.bigint()])
    .transform((value: number | bigint): number => Number(value))
    .pipe(z.number().int().nonnegative().safe()),
});

function schemaVersion(database: Database): number {
  using statement: Statement<unknown, []> = database.prepare("PRAGMA user_version");
  return UserVersionRowSchema.parse(statement.get()).user_version;
}

export function migrateLocalVault(database: Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version: number = schemaVersion(database);
    if (version > VAULT_SCHEMA_VERSION) {
      throw new Error(`E2E vault schema ${version} is newer than this Murmur build supports`);
    }
    if (version === 0) {
      database.exec(`
        CREATE TABLE root_keys (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          root_key_id TEXT NOT NULL UNIQUE,
          public_key BLOB NOT NULL CHECK(length(public_key) = 32),
          private_key BLOB NOT NULL CHECK(length(private_key) = 64),
          created_at TEXT NOT NULL
        );
        CREATE TABLE agent_keys (
          agent_id TEXT PRIMARY KEY,
          root_key_id TEXT NOT NULL REFERENCES root_keys(root_key_id),
          signing_key_id TEXT NOT NULL UNIQUE,
          public_key BLOB NOT NULL CHECK(length(public_key) = 32),
          private_key BLOB NOT NULL CHECK(length(private_key) = 64),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          certificate_signature BLOB NOT NULL CHECK(length(certificate_signature) = 64)
        );
        CREATE TABLE prekeys (
          prekey_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agent_keys(agent_id),
          prekey_class TEXT NOT NULL CHECK(prekey_class IN ('one_time', 'fallback')),
          public_key BLOB NOT NULL CHECK(length(public_key) = 32),
          private_key BLOB CHECK(private_key IS NULL OR length(private_key) = 32),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          certificate_signature BLOB NOT NULL CHECK(length(certificate_signature) = 64)
        );
        CREATE INDEX prekeys_agent_available
          ON prekeys(agent_id, prekey_class, consumed_at, expires_at, prekey_id);
        CREATE TABLE peer_pins (
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          root_key_id TEXT NOT NULL,
          public_key BLOB NOT NULL CHECK(length(public_key) = 32),
          verification_mode TEXT NOT NULL CHECK(verification_mode IN ('strict', 'organization', 'tofu')),
          verified_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id, agent_id)
        );
        CREATE TABLE pair_counters (
          tenant_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          last_counter INTEGER NOT NULL CHECK(last_counter >= 0),
          PRIMARY KEY(tenant_id, sender_id, recipient_id)
        );
        CREATE TABLE outbox (
          logical_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          pair_counter INTEGER NOT NULL CHECK(pair_counter > 0),
          plaintext TEXT NOT NULL CHECK(length(plaintext) BETWEEN 1 AND 100000),
          plaintext_digest BLOB NOT NULL CHECK(length(plaintext_digest) = 32),
          envelope_json TEXT CHECK(envelope_json IS NULL OR length(envelope_json) <= 1048576),
          created_at TEXT NOT NULL,
          UNIQUE(tenant_id, sender_id, recipient_id, pair_counter)
        );
        CREATE UNIQUE INDEX outbox_one_pending_pair
          ON outbox(tenant_id, sender_id, recipient_id);
        CREATE TABLE replay_ledger (
          tenant_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          last_counter INTEGER NOT NULL CHECK(last_counter > 0),
          PRIMARY KEY(tenant_id, sender_id, recipient_id)
        );
        CREATE TABLE decrypted_cache (
          message_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          pair_counter INTEGER NOT NULL CHECK(pair_counter > 0),
          plaintext TEXT NOT NULL CHECK(length(plaintext) BETWEEN 1 AND 100000),
          expires_at TEXT NOT NULL,
          UNIQUE(tenant_id, sender_id, recipient_id, pair_counter)
        );
        CREATE INDEX decrypted_cache_expiration ON decrypted_cache(expires_at);
        PRAGMA user_version = 1;
      `);
    }
    if (version <= 1) {
      database.exec(`
        CREATE TABLE trust_policy_state (
          tenant_id TEXT PRIMARY KEY,
          issuer_key_id TEXT NOT NULL,
          issuer_public_key BLOB NOT NULL CHECK(length(issuer_public_key) = 32),
          version INTEGER NOT NULL CHECK(version > 0),
          expires_at TEXT NOT NULL,
          signature BLOB NOT NULL CHECK(length(signature) = 64),
          imported_at TEXT NOT NULL
        );
        CREATE TABLE trust_policy_revocations (
          tenant_id TEXT NOT NULL REFERENCES trust_policy_state(tenant_id) ON DELETE CASCADE,
          root_key_id TEXT NOT NULL,
          revoked_at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
          PRIMARY KEY(tenant_id, root_key_id)
        );
        PRAGMA user_version = 2;
      `);
    }
    if (version <= 2) {
      database.exec(`
        ALTER TABLE outbox ADD COLUMN claim_id TEXT;
        PRAGMA user_version = 3;
      `);
    }
    if (version <= 3) {
      database.exec(`
        ALTER TABLE outbox ADD COLUMN thread_id TEXT;
        UPDATE outbox SET thread_id = logical_id WHERE thread_id IS NULL;
        CREATE TABLE sent_receipts (
          logical_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          pair_counter INTEGER NOT NULL CHECK(pair_counter > 0),
          plaintext_digest BLOB NOT NULL CHECK(length(plaintext_digest) = 32),
          claim_id TEXT NOT NULL,
          envelope_json TEXT NOT NULL CHECK(length(envelope_json) <= 1048576),
          verification_mode TEXT NOT NULL
            CHECK(verification_mode IN ('strict', 'organization', 'tofu')),
          expires_at TEXT NOT NULL,
          UNIQUE(tenant_id, sender_id, recipient_id, pair_counter)
        );
        CREATE INDEX sent_receipts_expiration ON sent_receipts(expires_at);
        PRAGMA user_version = 4;
      `);
    }
    if (version <= 4) {
      database.exec(`
        ALTER TABLE prekeys ADD COLUMN agent_signing_key_id TEXT;
        UPDATE prekeys
        SET agent_signing_key_id = (
          SELECT agent_keys.signing_key_id
          FROM agent_keys
          WHERE agent_keys.agent_id = prekeys.agent_id
        );
        CREATE INDEX prekeys_signing_generation
          ON prekeys(agent_id, agent_signing_key_id, prekey_class, expires_at, prekey_id);
        PRAGMA user_version = 5;
      `);
    }
    if (version <= 5) {
      database.exec(`
        CREATE TABLE peer_root_expectations (
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          root_key_id TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id, agent_id)
        );
        PRAGMA user_version = 6;
      `);
    }
    if (version <= 6) {
      database.exec(`
        CREATE TABLE active_tenant_binding (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          tenant_id TEXT NOT NULL,
          bound_at TEXT NOT NULL
        );
        PRAGMA user_version = 7;
      `);
    }
    if (version <= 7) {
      database.exec(`
        CREATE TABLE agent_key_revocations (
          agent_id TEXT NOT NULL,
          revoked_signing_key_id TEXT NOT NULL,
          root_key_id TEXT NOT NULL REFERENCES root_keys(root_key_id),
          revoked_at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
          signature BLOB NOT NULL CHECK(length(signature) = 64),
          PRIMARY KEY(agent_id, revoked_signing_key_id)
        );
        CREATE INDEX agent_key_revocations_order
          ON agent_key_revocations(agent_id, revoked_signing_key_id);
        PRAGMA user_version = 8;
      `);
    }
    if (version <= 8) {
      database.exec(`
        CREATE TABLE orchestration_routes (
          logical_id TEXT PRIMARY KEY CHECK(length(logical_id) BETWEEN 1 AND 200),
          orchestrator_json TEXT NOT NULL CHECK(length(orchestrator_json) <= 2048),
          expires_at TEXT NOT NULL
        );
        CREATE INDEX orchestration_routes_expiration ON orchestration_routes(expires_at);
        PRAGMA user_version = 9;
      `);
    }
    if (version <= 9) {
      database.exec(`
        DROP INDEX decrypted_cache_expiration;
        DROP TABLE decrypted_cache;
        CREATE TABLE decrypted_cache (
          message_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          pair_counter INTEGER NOT NULL CHECK(pair_counter > 0),
          tenant_sequence INTEGER NOT NULL CHECK(tenant_sequence > 0),
          wire_digest BLOB NOT NULL CHECK(length(wire_digest) = 32),
          plaintext TEXT NOT NULL CHECK(length(plaintext) BETWEEN 1 AND 100000),
          expires_at TEXT NOT NULL,
          UNIQUE(tenant_id, sender_id, recipient_id, pair_counter)
        );
        CREATE INDEX decrypted_cache_expiration ON decrypted_cache(expires_at);
        PRAGMA user_version = 10;
      `);
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
