import type { Database } from "bun:sqlite";

import type { Instant } from "../domain/value-objects.js";
import { type EncryptedEnvelopeDto, EncryptedEnvelopeDtoSchema } from "../e2ee/wire-contracts.js";
import {
  type CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastInputSchema,
  type CancelEncryptedBroadcastOutput,
  CancelEncryptedBroadcastOutputSchema,
  type CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastInputSchema,
  type CommitEncryptedBroadcastOutput,
  CommitEncryptedBroadcastOutputSchema,
} from "../e2ee/wire-tools.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
import {
  assertSqliteE2eeBroadcastAuthorization,
  readSqliteE2eeBroadcast,
  sqliteE2eeOpenAgentGeneration,
} from "./sqlite-e2ee-broadcast-state.js";
import {
  type SqliteE2eeBroadcastRow,
  SqliteE2eeCountRowSchema,
  type SqliteE2eeDeliveryRow,
  SqliteE2eeDeliveryRowSchema,
} from "./sqlite-e2ee-rows.js";
import { updateSqliteE2eeUsage } from "./sqlite-e2ee-usage.js";

function allDeliveries(database: Database, broadcastId: string): readonly SqliteE2eeDeliveryRow[] {
  const raw: unknown[] = database
    .query<unknown, [string]>(`
      SELECT accepted_at, ciphertext_bytes, claim_id, envelope_json,
        recipient_generation, recipient_id, sender_chain_json
      FROM e2ee_broadcast_deliveries WHERE broadcast_id = ? ORDER BY recipient_id ASC
    `)
    .all(broadcastId);
  return raw.map((row: unknown): SqliteE2eeDeliveryRow => SqliteE2eeDeliveryRowSchema.parse(row));
}

function committedOutput(
  row: SqliteE2eeBroadcastRow,
  duplicate: boolean,
): CommitEncryptedBroadcastOutput {
  if (row.committed_at === null) throw new Error("Encrypted broadcast commit time is missing");
  return CommitEncryptedBroadcastOutputSchema.parse({
    broadcast_id: row.broadcast_id,
    committed_at: row.committed_at,
    duplicate,
    recipient_count: row.recipient_count,
    status: "stored",
  });
}

function insertDeliveries(
  database: Database,
  broadcastId: string,
  senderGeneration: number,
  deliveries: readonly SqliteE2eeDeliveryRow[],
): number {
  let ciphertextBytes: number = 0;
  for (const delivery of deliveries) {
    if (
      delivery.envelope_json === null ||
      delivery.sender_chain_json === null ||
      delivery.ciphertext_bytes === null
    ) {
      throw new Error("Encrypted broadcast delivery set is incomplete");
    }
    const envelope: EncryptedEnvelopeDto = EncryptedEnvelopeDtoSchema.parse(
      JSON.parse(delivery.envelope_json),
    );
    ciphertextBytes += delivery.ciphertext_bytes;
    database
      .query<
        unknown,
        [
          string,
          string,
          string,
          number,
          string,
          number,
          string,
          string,
          number,
          string,
          string,
          number,
          string,
          string,
        ]
      >(`
        INSERT INTO e2ee_messages(
          message_id, thread_id, sender_id, sender_generation, recipient_id,
          recipient_generation, broadcast_id, idempotency_key, pair_counter,
          envelope_json, sender_chain_json, ciphertext_bytes, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        envelope.header.message_id,
        envelope.header.thread_id,
        envelope.header.sender_id,
        senderGeneration,
        delivery.recipient_id,
        delivery.recipient_generation,
        broadcastId,
        envelope.header.idempotency_key,
        envelope.header.pair_counter,
        delivery.envelope_json,
        delivery.sender_chain_json,
        delivery.ciphertext_bytes,
        envelope.header.created_at,
        envelope.header.expires_at,
      );
  }
  return ciphertextBytes;
}

export function commitSqliteEncryptedBroadcast(
  database: Database,
  inputValue: unknown,
  now: Instant,
  authorization: E2eeWriteAuthorization,
): CommitEncryptedBroadcastOutput {
  const input: CommitEncryptedBroadcastInput =
    CommitEncryptedBroadcastInputSchema.parse(inputValue);
  database.exec("BEGIN IMMEDIATE");
  try {
    const broadcast: SqliteE2eeBroadcastRow = readSqliteE2eeBroadcast(database, input.broadcast_id);
    assertSqliteE2eeBroadcastAuthorization(broadcast, authorization);
    if (broadcast.state === "committed") {
      database.exec("COMMIT");
      return committedOutput(broadcast, true);
    }
    if (broadcast.state !== "pending" || broadcast.expires_at <= now.toISOString()) {
      throw new Error("Encrypted broadcast is unavailable or expired");
    }
    const deliveries: readonly SqliteE2eeDeliveryRow[] = allDeliveries(
      database,
      input.broadcast_id,
    );
    if (
      deliveries.length !== broadcast.recipient_count ||
      deliveries.some((delivery: SqliteE2eeDeliveryRow): boolean => delivery.envelope_json === null)
    ) {
      throw new Error("Encrypted broadcast delivery set is incomplete");
    }
    if (
      sqliteE2eeOpenAgentGeneration(database, broadcast.sender_id) !== broadcast.sender_generation
    ) {
      throw new Error("Encrypted broadcast sender generation changed");
    }
    const ciphertextBytes: number = insertDeliveries(
      database,
      input.broadcast_id,
      broadcast.sender_generation,
      deliveries,
    );
    database
      .query<unknown, [string, string]>(`
        UPDATE e2ee_broadcasts SET state = 'committed', committed_at = ?
        WHERE broadcast_id = ? AND state = 'pending'
      `)
      .run(now.toISOString(), input.broadcast_id);
    updateSqliteE2eeUsage(database, {
      claimCount: -deliveries.length,
      pendingBroadcastCount: -1,
      pendingCiphertextBytes: -ciphertextBytes,
      pendingDeliveryCount: -deliveries.length,
      publicPrekeyCount: 0,
      retainedCiphertextBytes: ciphertextBytes,
      retainedMessageCount: deliveries.length,
    });
    const committed: SqliteE2eeBroadcastRow = readSqliteE2eeBroadcast(database, input.broadcast_id);
    database.exec("COMMIT");
    return committedOutput(committed, false);
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function pendingCiphertextBytes(database: Database, broadcastId: string): number {
  const raw: unknown = database
    .query<unknown, [string]>(`
      SELECT COALESCE(SUM(ciphertext_bytes), 0) AS count
      FROM e2ee_broadcast_deliveries WHERE broadcast_id = ?
    `)
    .get(broadcastId);
  return SqliteE2eeCountRowSchema.parse(raw).count;
}

export function cancelSqliteEncryptedBroadcast(
  database: Database,
  inputValue: unknown,
  authorization: E2eeWriteAuthorization,
): CancelEncryptedBroadcastOutput {
  const input: CancelEncryptedBroadcastInput =
    CancelEncryptedBroadcastInputSchema.parse(inputValue);
  database.exec("BEGIN IMMEDIATE");
  try {
    const broadcast: SqliteE2eeBroadcastRow = readSqliteE2eeBroadcast(database, input.broadcast_id);
    assertSqliteE2eeBroadcastAuthorization(broadcast, authorization);
    if (broadcast.state === "committed") {
      database.exec("COMMIT");
      return CancelEncryptedBroadcastOutputSchema.parse({ cancelled: false });
    }
    if (broadcast.state === "cancelled") {
      database.exec("COMMIT");
      return CancelEncryptedBroadcastOutputSchema.parse({ cancelled: true });
    }
    const ciphertextBytes: number = pendingCiphertextBytes(database, input.broadcast_id);
    database
      .query<unknown, [string]>(`
        UPDATE e2ee_broadcasts SET state = 'cancelled'
        WHERE broadcast_id = ? AND state = 'pending'
      `)
      .run(input.broadcast_id);
    updateSqliteE2eeUsage(database, {
      claimCount: -broadcast.recipient_count,
      pendingBroadcastCount: -1,
      pendingCiphertextBytes: -ciphertextBytes,
      pendingDeliveryCount: -broadcast.recipient_count,
      publicPrekeyCount: 0,
      retainedCiphertextBytes: 0,
      retainedMessageCount: 0,
    });
    database.exec("COMMIT");
    return CancelEncryptedBroadcastOutputSchema.parse({ cancelled: true });
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
