import type { TransactionSql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
import {
  type PostgresE2eeBroadcastRow,
  PostgresE2eeBroadcastRowSchema,
} from "./postgres-e2ee-rows.js";

export async function readPostgresE2eeBroadcast(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcastId: string,
): Promise<PostgresE2eeBroadcastRow> {
  const raw: unknown = await transaction`
    SELECT broadcast_id::text AS broadcast_id,
      CASE WHEN committed_at IS NULL THEN NULL ELSE
        to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS committed_at,
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      recipient_count, request_json::text AS request_json, sender_authority,
      sender_generation, sender_id, state, thread_id
    FROM murmur.e2ee_broadcasts
    WHERE tenant_id = ${tenantId.value}::uuid AND broadcast_id = ${broadcastId}::uuid
    FOR UPDATE
  `;
  const rows: PostgresE2eeBroadcastRow[] = z.array(PostgresE2eeBroadcastRowSchema).parse(raw);
  const row: PostgresE2eeBroadcastRow | undefined = rows[0];
  if (row === undefined) throw new Error("Encrypted broadcast is unavailable or expired");
  return row;
}

export function assertPostgresE2eeBroadcastAuthorization(
  broadcast: PostgresE2eeBroadcastRow,
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
