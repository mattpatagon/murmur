import { type Changes, Database, type Statement } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import { z } from "zod";

import { LocalVaultKeys } from "./local-vault-keys.js";
import {
  type CachedMessage,
  mapCachedMessageRow,
  mapOutboxRow,
  mapSentReceiptRow,
  type OutboxItem,
  type SentReceipt,
  type StoredPrekey,
  safeSqlCount,
} from "./local-vault-rows.js";
import { migrateLocalVault } from "./local-vault-schema.js";
import { LocalVaultSettings } from "./local-vault-settings.js";
import { LocalVaultTrust } from "./local-vault-trust.js";
import { prepareVaultDirectory, protectVaultFile } from "./vault-paths.js";

const MAX_ENVELOPE_JSON_BYTES: number = 1024 * 1024;
const ClaimIdSchema: z.ZodString = z.string().uuid();

export type BeginOutboxInput = {
  readonly createdAt: string;
  readonly logicalId: string;
  readonly plaintext: string;
  readonly plaintextDigest: Uint8Array;
  readonly recipientId: string;
  readonly senderId: string;
  readonly tenantId: string;
  readonly threadId: string;
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
    existing.threadId === input.threadId &&
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

function receiptMatchesOutbox(receipt: SentReceipt, outbox: OutboxItem): boolean {
  return (
    receipt.tenantId === outbox.tenantId &&
    receipt.senderId === outbox.senderId &&
    receipt.recipientId === outbox.recipientId &&
    receipt.pairCounter === outbox.pairCounter &&
    receipt.claimId === outbox.claimId &&
    receipt.envelopeJson === outbox.envelopeJson &&
    sameDigest(receipt.plaintextDigest, outbox.plaintextDigest)
  );
}

export class LocalE2eeVault {
  readonly #database: Database;
  #closed: boolean = false;
  public readonly keys: LocalVaultKeys;
  public readonly settings: LocalVaultSettings;
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
    this.settings = new LocalVaultSettings(this.#database);
    this.trust = new LocalVaultTrust(this.#database);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("The E2E vault is closed");
  }

  public getOutbox(logicalId: string): OutboxItem | null {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT logical_id, tenant_id, sender_id, recipient_id, pair_counter,
             plaintext, plaintext_digest, claim_id, envelope_json, created_at, thread_id
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
        [string, string, string, string, number, string, Uint8Array, string, string]
      > = this.#database.query(`
        INSERT INTO outbox(
          logical_id, tenant_id, sender_id, recipient_id, pair_counter,
          plaintext, plaintext_digest, created_at, thread_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.threadId,
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

  public setOutboxEnvelope(logicalId: string, claimId: string, envelopeJson: string): OutboxItem {
    this.#ensureOpen();
    ClaimIdSchema.parse(claimId);
    if (Buffer.byteLength(envelopeJson, "utf8") > MAX_ENVELOPE_JSON_BYTES) {
      throw new Error("Encrypted envelope exceeds the local outbox limit");
    }
    const existing: OutboxItem | null = this.getOutbox(logicalId);
    if (existing === null) throw new Error("Outbox item does not exist");
    if (
      (existing.claimId !== null && existing.claimId !== claimId) ||
      (existing.envelopeJson !== null && existing.envelopeJson !== envelopeJson)
    ) {
      throw new Error("Outbox envelope conflict");
    }
    const statement: Statement<unknown, [string, string, string]> = this.#database.query(`
      UPDATE outbox SET claim_id = ?, envelope_json = ? WHERE logical_id = ?
    `);
    statement.run(claimId, envelopeJson, logicalId);
    const updated: OutboxItem | null = this.getOutbox(logicalId);
    if (updated === null) throw new Error("Outbox item disappeared during update");
    return updated;
  }

  public replaceExpiredOutboxClaim(logicalId: string, createdAt: string): OutboxItem {
    this.#ensureOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing: OutboxItem | null = this.getOutbox(logicalId);
      if (existing === null) throw new Error("Outbox item does not exist");
      if (existing.claimId === null && existing.envelopeJson === null) {
        this.#database.exec("COMMIT");
        return existing;
      }
      if (existing.claimId === null || existing.envelopeJson === null) {
        throw new Error("Outbox claim and envelope state is inconsistent");
      }
      const nextCounter: number = existing.pairCounter + 1;
      if (!Number.isSafeInteger(nextCounter)) throw new Error("Pair counter is exhausted");
      const updateCounter: Statement<unknown, [number, string, string, string]> =
        this.#database.query(`
          UPDATE pair_counters SET last_counter = ?
          WHERE tenant_id = ? AND sender_id = ? AND recipient_id = ?
        `);
      if (
        updateCounter.run(nextCounter, existing.tenantId, existing.senderId, existing.recipientId)
          .changes !== 1
      ) {
        throw new Error("Outbox pair counter is unavailable");
      }
      const updateOutbox: Statement<unknown, [number, string, string]> = this.#database.query(`
        UPDATE outbox
        SET pair_counter = ?, claim_id = NULL, envelope_json = NULL, created_at = ?
        WHERE logical_id = ?
      `);
      if (updateOutbox.run(nextCounter, createdAt, logicalId).changes !== 1) {
        throw new Error("Outbox item disappeared during claim replacement");
      }
      this.#database.exec("COMMIT");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    const replaced: OutboxItem | null = this.getOutbox(logicalId);
    if (replaced === null) throw new Error("Outbox item disappeared after claim replacement");
    return replaced;
  }

  public resolveOutbox(logicalId: string): boolean {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(
      "DELETE FROM outbox WHERE logical_id = ?",
    );
    return statement.run(logicalId).changes === 1;
  }

  public getSentReceipt(logicalId: string): SentReceipt | null {
    this.#ensureOpen();
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT logical_id, tenant_id, sender_id, recipient_id, pair_counter,
             plaintext_digest, claim_id, envelope_json, verification_mode, expires_at
      FROM sent_receipts WHERE logical_id = ?
    `);
    const row: unknown = statement.get(logicalId);
    return row === null ? null : mapSentReceiptRow(row);
  }

  public commitOutbox(
    logicalId: string,
    expiresAt: string,
    verificationMode: "organization" | "strict" | "tofu",
  ): SentReceipt {
    this.#ensureOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const outbox: OutboxItem | null = this.getOutbox(logicalId);
      if (outbox === null || outbox.claimId === null || outbox.envelopeJson === null) {
        const existing: SentReceipt | null = this.getSentReceipt(logicalId);
        if (existing === null) throw new Error("Complete outbox item does not exist");
        this.#database.exec("COMMIT");
        return existing;
      }
      const insert: Statement<
        unknown,
        [string, string, string, string, number, Uint8Array, string, string, string, string]
      > = this.#database.query(`
        INSERT OR IGNORE INTO sent_receipts(
          logical_id, tenant_id, sender_id, recipient_id, pair_counter,
          plaintext_digest, claim_id, envelope_json, verification_mode, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        outbox.logicalId,
        outbox.tenantId,
        outbox.senderId,
        outbox.recipientId,
        outbox.pairCounter,
        outbox.plaintextDigest,
        outbox.claimId,
        outbox.envelopeJson,
        verificationMode,
        expiresAt,
      );
      const receipt: SentReceipt | null = this.getSentReceipt(logicalId);
      if (
        receipt === null ||
        !receiptMatchesOutbox(receipt, outbox) ||
        receipt.verificationMode !== verificationMode
      ) {
        throw new Error("Sent receipt idempotency conflict");
      }
      const remove: Statement<unknown, [string]> = this.#database.query(
        "DELETE FROM outbox WHERE logical_id = ?",
      );
      if (remove.run(logicalId).changes !== 1) throw new Error("Committed outbox did not resolve");
      this.#database.exec("COMMIT");
      return receipt;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
    this.keys.purgeExpiredPrivatePrekeys(now);
    const statement: Statement<unknown, [string]> = this.#database.query(
      "DELETE FROM decrypted_cache WHERE expires_at <= ?",
    );
    const deleted: number = statement.run(now).changes;
    const receipts: Statement<unknown, [string]> = this.#database.query(
      "DELETE FROM sent_receipts WHERE expires_at <= ?",
    );
    receipts.run(now);
    return deleted;
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
