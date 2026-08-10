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
    "SELECT COUNT(*) AS count FROM e2ee_messages WHERE expires_at <= ?",
    now,
  );
  const messageBytes: number = count(
    database,
    `SELECT COALESCE(SUM(ciphertext_bytes), 0) AS count
      FROM e2ee_messages WHERE expires_at <= ?`,
    now,
  );
  database
    .query<unknown, [string]>("DELETE FROM e2ee_messages WHERE expires_at <= ?")
    .run(now.toISOString());
  return { bytes: messageBytes, count: messageCount };
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
    if (directClaimCount !== 0 || expiredBroadcasts.pendingCount !== 0 || messages.count !== 0) {
      updateSqliteE2eeUsage(database, {
        claimCount: -directClaimCount - expiredBroadcasts.deliveryCount,
        pendingBroadcastCount: -expiredBroadcasts.pendingCount,
        pendingCiphertextBytes: -expiredBroadcasts.ciphertextBytes,
        pendingDeliveryCount: -expiredBroadcasts.deliveryCount,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: -messages.bytes,
        retainedMessageCount: -messages.count,
      });
    }
    database.exec("COMMIT");
    return messages.count;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
