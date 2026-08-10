import { type Changes, Database, type Statement } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";

import { LocalVaultKeys } from "./local-vault-keys.js";
import {
  type CachedMessage,
  mapCachedMessageRow,
  mapOutboxRow,
  type OutboxItem,
  type StoredPrekey,
  safeSqlCount,
} from "./local-vault-rows.js";
import { migrateLocalVault } from "./local-vault-schema.js";
import { LocalVaultTrust } from "./local-vault-trust.js";
import { prepareVaultDirectory, protectVaultFile } from "./vault-paths.js";

const MAX_ENVELOPE_JSON_BYTES: number = 1024 * 1024;

export type BeginOutboxInput = {
  readonly createdAt: string;
  readonly logicalId: string;
  readonly plaintext: string;
  readonly plaintextDigest: Uint8Array;
  readonly recipientId: string;
  readonly senderId: string;
  readonly tenantId: string;
};

export type CacheDecryptedInput = {
  readonly expiresAt: string;
  readonly messageId: string;
  readonly pairCounter: number;
  readonly plaintext: string;
  readonly prekeyId: string;
  readonly recipientId: string;
  readonly senderId: string;
  readonly tenantId: string;
  readonly verifiedAt: string;
};

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function outboxMatches(existing: OutboxItem, input: BeginOutboxInput): boolean {
  return (
    existing.tenantId === input.tenantId &&
    existing.senderId === input.senderId &&
    existing.recipientId === input.recipientId &&
    existing.plaintext === input.plaintext &&
    sameDigest(existing.plaintextDigest, input.plaintextDigest)
  );
}

function cachedMessageMatches(existing: CachedMessage, input: CacheDecryptedInput): boolean {
  return (
    existing.tenantId === input.tenantId &&
    existing.senderId === input.senderId &&
    existing.recipientId === input.recipientId &&
    existing.pairCounter === input.pairCounter &&
    existing.plaintext === input.plaintext &&
    existing.expiresAt === input.expiresAt
  );
}

export class LocalE2eeVault {
  readonly #database: Database;
  #closed: boolean = false;
  public readonly keys: LocalVaultKeys;
  public readonly trust: LocalVaultTrust;

  public constructor(path: string, platform: NodeJS.Platform = process.platform) {
    prepareVaultDirectory(path, platform);
    this.#database = new Database(path, {
      create: true,
      readwrite: true,
      safeIntegers: true,
      strict: true,
    });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    migrateLocalVault(this.#database);
    protectVaultFile(path, platform);
    this.keys = new LocalVaultKeys(this.#database);
    this.trust = new LocalVaultTrust(this.#database);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("The E2E vault is closed");
  }

  public getOutbox(logicalId: string): OutboxItem | null {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT logical_id, tenant_id, sender_id, recipient_id, pair_counter,
             plaintext, plaintext_digest, envelope_json, created_at
      FROM outbox WHERE logical_id = ?
    `);
    const row: unknown = statement.get(logicalId);
    return row === null ? null : mapOutboxRow(row);
  }

  public beginOutbox(input: BeginOutboxInput): OutboxItem {
    this.#ensureOpen();
    if (input.plaintextDigest.byteLength !== 32) {
      throw new Error("Outbox plaintext digest must be 32 bytes");
    }
    const existing: OutboxItem | null = this.getOutbox(input.logicalId);
    if (existing !== null) {
      if (!outboxMatches(existing, input)) throw new Error("Outbox idempotency conflict");
      return existing;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const afterLock: OutboxItem | null = this.getOutbox(input.logicalId);
      if (afterLock !== null) {
        if (!outboxMatches(afterLock, input)) throw new Error("Outbox idempotency conflict");
        this.#database.exec("COMMIT");
        return afterLock;
      }
      const pendingStatement: Statement<unknown, [string, string, string]> = this.#database.query(`
        SELECT COUNT(*) AS count FROM outbox
        WHERE tenant_id = ? AND sender_id = ? AND recipient_id = ?
      `);
      const pending: number = safeSqlCount(
        pendingStatement.get(input.tenantId, input.senderId, input.recipientId),
      );
      if (pending !== 0) throw new Error("Resolve the existing pair outbox before sending again");

      const counterStatement: Statement<unknown, [string, string, string]> = this.#database.query(`
        SELECT last_counter AS count FROM pair_counters
        WHERE tenant_id = ? AND sender_id = ? AND recipient_id = ?
      `);
      const counterRow: unknown = counterStatement.get(
        input.tenantId,
        input.senderId,
        input.recipientId,
      );
      const previousCounter: number = counterRow === null ? 0 : safeSqlCount(counterRow);
      if (previousCounter >= Number.MAX_SAFE_INTEGER) throw new Error("Pair counter is exhausted");
      const pairCounter: number = previousCounter + 1;

      const upsertCounter: Statement<unknown, [string, string, string, number]> =
        this.#database.query(`
          INSERT INTO pair_counters(tenant_id, sender_id, recipient_id, last_counter)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(tenant_id, sender_id, recipient_id) DO UPDATE SET
            last_counter = excluded.last_counter
        `);
      upsertCounter.run(input.tenantId, input.senderId, input.recipientId, pairCounter);
      const insert: Statement<
        unknown,
        [string, string, string, string, number, string, Uint8Array, string]
      > = this.#database.query(`
        INSERT INTO outbox(
          logical_id, tenant_id, sender_id, recipient_id, pair_counter,
          plaintext, plaintext_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        input.logicalId,
        input.tenantId,
        input.senderId,
        input.recipientId,
        pairCounter,
        input.plaintext,
        input.plaintextDigest,
        input.createdAt,
      );
      this.#database.exec("COMMIT");
      const created: OutboxItem | null = this.getOutbox(input.logicalId);
      if (created === null) throw new Error("Outbox insert did not persist");
      return created;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public setOutboxEnvelope(logicalId: string, envelopeJson: string): OutboxItem {
    this.#ensureOpen();
    if (Buffer.byteLength(envelopeJson, "utf8") > MAX_ENVELOPE_JSON_BYTES) {
      throw new Error("Encrypted envelope exceeds the local outbox limit");
    }
    const existing: OutboxItem | null = this.getOutbox(logicalId);
    if (existing === null) throw new Error("Outbox item does not exist");
    if (existing.envelopeJson !== null && existing.envelopeJson !== envelopeJson) {
      throw new Error("Outbox envelope conflict");
    }
    const statement: Statement<unknown, [string, string]> = this.#database.query(`
      UPDATE outbox SET envelope_json = ? WHERE logical_id = ?
    `);
    statement.run(envelopeJson, logicalId);
    const updated: OutboxItem | null = this.getOutbox(logicalId);
    if (updated === null) throw new Error("Outbox item disappeared during update");
    return updated;
  }

  public resolveOutbox(logicalId: string): boolean {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(
      "DELETE FROM outbox WHERE logical_id = ?",
    );
    return statement.run(logicalId).changes === 1;
  }

  public getCachedMessage(messageId: string): CachedMessage | null {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT message_id, tenant_id, sender_id, recipient_id, pair_counter, plaintext, expires_at
      FROM decrypted_cache WHERE message_id = ?
    `);
    const row: unknown = statement.get(messageId);
    return row === null ? null : mapCachedMessageRow(row);
  }

  public cacheDecryptedAndConsumePrekey(input: CacheDecryptedInput): CachedMessage {
    this.#ensureOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing: CachedMessage | null = this.getCachedMessage(input.messageId);
      if (existing !== null) {
        if (!cachedMessageMatches(existing, input)) {
          throw new Error("Decrypted cache identity conflict");
        }
        this.#database.exec("COMMIT");
        return existing;
      }
      const replayStatement: Statement<unknown, [string, string, string]> = this.#database.query(`
        SELECT last_counter AS count FROM replay_ledger
        WHERE tenant_id = ? AND sender_id = ? AND recipient_id = ?
      `);
      const replayRow: unknown = replayStatement.get(
        input.tenantId,
        input.senderId,
        input.recipientId,
      );
      const previousCounter: number = replayRow === null ? 0 : safeSqlCount(replayRow);
      if (input.pairCounter <= previousCounter)
        throw new Error("Encrypted message replay detected");
      const prekey: StoredPrekey | null = this.keys.getPrekey(input.prekeyId);
      if (
        prekey === null ||
        prekey.certificate.agentId !== input.recipientId ||
        prekey.privateKey === null
      ) {
        throw new Error("Recipient prekey is unavailable");
      }

      const insertCache: Statement<
        unknown,
        [string, string, string, string, number, string, string]
      > = this.#database.query(`
          INSERT INTO decrypted_cache(
            message_id, tenant_id, sender_id, recipient_id, pair_counter, plaintext, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
      insertCache.run(
        input.messageId,
        input.tenantId,
        input.senderId,
        input.recipientId,
        input.pairCounter,
        input.plaintext,
        input.expiresAt,
      );
      const upsertReplay: Statement<unknown, [string, string, string, number]> =
        this.#database.query(`
          INSERT INTO replay_ledger(tenant_id, sender_id, recipient_id, last_counter)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(tenant_id, sender_id, recipient_id) DO UPDATE SET
            last_counter = excluded.last_counter
        `);
      upsertReplay.run(input.tenantId, input.senderId, input.recipientId, input.pairCounter);
      if (prekey.certificate.prekeyClass === "one_time") {
        const consume: Statement<unknown, [string, string]> = this.#database.query(`
          UPDATE prekeys SET private_key = NULL, consumed_at = ?
          WHERE prekey_id = ? AND private_key IS NOT NULL
        `);
        const consumed: Changes = consume.run(input.verifiedAt, input.prekeyId);
        if (consumed.changes !== 1) throw new Error("One-time prekey was already consumed");
      }
      this.#database.exec("COMMIT");
      const cached: CachedMessage | null = this.getCachedMessage(input.messageId);
      if (cached === null) throw new Error("Decrypted cache insert did not persist");
      return cached;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public purgeExpired(now: string): number {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(
      "DELETE FROM decrypted_cache WHERE expires_at <= ?",
    );
    return statement.run(now).changes;
  }

  public purgeCachedMessages(messageIds: readonly string[]): number {
    this.#ensureOpen();
    if (messageIds.length === 0 || messageIds.length > 500) {
      throw new Error("Cache purge requires between 1 and 500 message IDs");
    }
    const statement: Statement<unknown, [string]> = this.#database.query(
      "DELETE FROM decrypted_cache WHERE message_id = ?",
    );
    return messageIds.reduce(
      (updated: number, messageId: string): number => updated + statement.run(messageId).changes,
      0,
    );
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close(false);
  }
}
