import type { Database } from "bun:sqlite";

import type { Instant } from "../domain/value-objects.js";
import { SqliteE2eeCountRowSchema } from "./sqlite-e2ee-rows.js";
import { updateSqliteE2eeUsage } from "./sqlite-e2ee-usage.js";

type ExpiredBroadcastUsage = {
  readonly ciphertextBytes: number;
  readonly deliveryCount: number;
  readonly pendingCount: number;
};

function count(database: Database, sql: string, now: Instant): number {
  return SqliteE2eeCountRowSchema.parse(
    database.query<unknown, [string]>(sql).get(now.toISOString()),
  ).count;
}

function expiredBroadcastUsage(database: Database, now: Instant): ExpiredBroadcastUsage {
  const pendingCount: number = count(
    database,
    "SELECT COUNT(*) AS count FROM e2ee_broadcasts WHERE state = 'pending' AND expires_at <= ?",
    now,
  );
  const deliveryCount: number = count(
    database,
    `SELECT COALESCE(SUM(recipient_count), 0) AS count
      FROM e2ee_broadcasts WHERE state = 'pending' AND expires_at <= ?`,
    now,
  );
  const ciphertextBytes: number = count(
    database,
    `SELECT COALESCE(SUM(delivery.ciphertext_bytes), 0) AS count
      FROM e2ee_broadcast_deliveries AS delivery
      JOIN e2ee_broadcasts AS broadcast ON broadcast.broadcast_id = delivery.broadcast_id
      WHERE broadcast.state = 'pending' AND broadcast.expires_at <= ?`,
    now,
  );
  return { ciphertextBytes, deliveryCount, pendingCount };
}

function pruneExpiredMessages(
  database: Database,
  now: Instant,
): {
  readonly bytes: number;
  readonly count: number;
} {
  const messageCount: number = count(
    database,
    `SELECT COUNT(*) AS count FROM e2ee_messages WHERE rowid IN (
      SELECT rowid FROM e2ee_messages WHERE expires_at <= ? ORDER BY sequence LIMIT 1000
    )`,
    now,
  );
  const messageBytes: number = count(
    database,
    `SELECT COALESCE(SUM(ciphertext_bytes), 0) AS count
      FROM e2ee_messages WHERE rowid IN (
        SELECT rowid FROM e2ee_messages WHERE expires_at <= ? ORDER BY sequence LIMIT 1000
      )`,
    now,
  );
  database
    .query<unknown, [string]>(`
      DELETE FROM e2ee_messages WHERE rowid IN (
        SELECT rowid FROM e2ee_messages WHERE expires_at <= ? ORDER BY sequence LIMIT 1000
      )
    `)
    .run(now.toISOString());
  return { bytes: messageBytes, count: messageCount };
}

function expirePublicPrekeys(database: Database, now: Instant): number {
  return database
    .query<unknown, [string, string]>(`
      UPDATE e2ee_prekeys SET retired_at = ? WHERE prekey_id IN (
        SELECT prekey_id FROM e2ee_prekeys
        WHERE retired_at IS NULL AND claimed_at IS NULL
          AND json_extract(certificate_json, '$.expires_at') <= ?
        ORDER BY prekey_id LIMIT 1000
      )
    `)
    .run(now.toISOString(), now.toISOString()).changes;
}

function cleanupExpiredRows(database: Database, now: Instant): void {
  database
    .query<unknown, [string]>(`
      DELETE FROM e2ee_claims WHERE rowid IN (
        SELECT rowid FROM e2ee_claims
        WHERE broadcast_id IS NULL AND expires_at <= ?
        ORDER BY claim_id LIMIT 1000
      )
    `)
    .run(now.toISOString());
  database
    .query<unknown, [string]>(`
      DELETE FROM e2ee_broadcasts WHERE rowid IN (
        SELECT broadcast.rowid FROM e2ee_broadcasts AS broadcast
        WHERE broadcast.state IN ('cancelled', 'committed')
          AND broadcast.expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM e2ee_messages AS message
            WHERE message.broadcast_id = broadcast.broadcast_id
          )
        ORDER BY broadcast.broadcast_id LIMIT 100
      )
    `)
    .run(now.toISOString());
  database
    .query<unknown, [string]>(`
      DELETE FROM e2ee_claims WHERE rowid IN (
        SELECT claim.rowid FROM e2ee_claims AS claim
        WHERE claim.broadcast_id IS NOT NULL AND claim.expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM e2ee_broadcasts AS broadcast
            WHERE broadcast.broadcast_id = claim.broadcast_id
          )
        ORDER BY claim.claim_id LIMIT 1000
      )
    `)
    .run(now.toISOString());
  database.exec(`
    DELETE FROM e2ee_prekeys WHERE rowid IN (
      SELECT prekey.rowid FROM e2ee_prekeys AS prekey
      WHERE (prekey.retired_at IS NOT NULL OR prekey.claimed_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM e2ee_claims AS claim WHERE claim.prekey_id = prekey.prekey_id
        )
      ORDER BY prekey.prekey_id LIMIT 1000
    )
  `);
}

export function pruneSqliteE2ee(database: Database, now: Instant): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    const expiredBroadcasts: ExpiredBroadcastUsage = expiredBroadcastUsage(database, now);
    const directClaimCount: number = count(
      database,
      `SELECT COUNT(*) AS count FROM e2ee_claims
        WHERE broadcast_id IS NULL AND consumed_at IS NULL AND expires_at <= ?`,
      now,
    );
    const expiredPrekeys: number = expirePublicPrekeys(database, now);
    database
      .query<unknown, [string, string]>(`
        UPDATE e2ee_claims SET consumed_at = ?
        WHERE broadcast_id IS NULL AND consumed_at IS NULL AND expires_at <= ?
      `)
      .run(now.toISOString(), now.toISOString());
    database
      .query<unknown, [string]>(`
        UPDATE e2ee_broadcasts SET state = 'cancelled'
        WHERE state = 'pending' AND expires_at <= ?
      `)
      .run(now.toISOString());
    const messages: { readonly bytes: number; readonly count: number } = pruneExpiredMessages(
      database,
      now,
    );
    if (
      directClaimCount !== 0 ||
      expiredBroadcasts.pendingCount !== 0 ||
      expiredPrekeys !== 0 ||
      messages.count !== 0
    ) {
      updateSqliteE2eeUsage(database, {
        claimCount: -directClaimCount - expiredBroadcasts.deliveryCount,
        pendingBroadcastCount: -expiredBroadcasts.pendingCount,
        pendingCiphertextBytes: -expiredBroadcasts.ciphertextBytes,
        pendingDeliveryCount: -expiredBroadcasts.deliveryCount,
        publicPrekeyCount: -expiredPrekeys,
        retainedCiphertextBytes: -messages.bytes,
        retainedMessageCount: -messages.count,
      });
    }
    cleanupExpiredRows(database, now);
    database.exec("COMMIT");
    return messages.count;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
