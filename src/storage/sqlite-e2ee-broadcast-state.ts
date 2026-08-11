import type { Database } from "bun:sqlite";

import { UnknownAgentError } from "../domain/errors.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
import { type SqliteE2eeBroadcastRow, SqliteE2eeBroadcastRowSchema } from "./sqlite-e2ee-rows.js";

export function sqliteE2eeOpenAgentGeneration(database: Database, agentId: string): number {
  const raw: unknown = database
    .query<unknown, [string]>(
      "SELECT generation FROM agents WHERE agent_id = ? AND closed_at IS NULL",
    )
    .get(agentId);
  if (raw === null) throw new UnknownAgentError(agentId);
  if (typeof raw !== "object") throw new Error("Stored agent generation is invalid");
  const generation: unknown = Reflect.get(raw, "generation");
  if (typeof generation !== "number" && typeof generation !== "bigint") {
    throw new Error("Stored agent generation is invalid");
  }
  return Number(generation);
}

export function readSqliteE2eeBroadcast(
  database: Database,
  broadcastId: string,
): SqliteE2eeBroadcastRow {
  const raw: unknown = database
    .query<unknown, [string]>(`
      SELECT broadcast_id, committed_at, expires_at, recipient_count, request_json,
        sender_authority, sender_generation, sender_id, state, thread_id
      FROM e2ee_broadcasts WHERE broadcast_id = ?
    `)
    .get(broadcastId);
  if (raw === null) throw new Error("Encrypted broadcast is unavailable or expired");
  return SqliteE2eeBroadcastRowSchema.parse(raw);
}

export function assertSqliteE2eeBroadcastAuthorization(
  broadcast: SqliteE2eeBroadcastRow,
  authorization: E2eeWriteAuthorization,
): void {
  if (
    (authorization.boundSenderId !== null && authorization.boundSenderId !== broadcast.sender_id) ||
    authorization.provenance.message_kind !== "message" ||
    authorization.provenance.orchestrator_policy_id !== null ||
    authorization.provenance.sender_authority !== broadcast.sender_authority
  ) {
    throw new Error("Encrypted broadcast authority is unavailable for this credential");
  }
}
