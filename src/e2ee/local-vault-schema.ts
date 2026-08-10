import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

const VAULT_SCHEMA_VERSION: number = 1;
const UserVersionRowSchema: z.ZodType<{ readonly user_version: number }> = z.object({
  user_version: z
    .union([z.number().int(), z.bigint()])
    .transform((value: number | bigint): number => Number(value))
    .pipe(z.number().int().nonnegative().safe()),
});

function schemaVersion(database: Database): number {
  const statement: Statement<unknown, []> = database.query("PRAGMA user_version");
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
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
