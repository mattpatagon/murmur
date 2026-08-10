import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { IdempotencyConflictError } from "../domain/errors.js";
import type { Message, SendMessageCommand, SendMessageResult } from "../domain/models.js";
import { type Instant, MessageId, type TenantId, ThreadId } from "../domain/value-objects.js";
import {
  firstRow,
  type MessageRow,
  MessageRowSchema,
  mapMessageRow,
} from "./postgres-message-rows.js";
import {
  lockPostgresRecipientCommitOrder,
  requirePostgresAgents,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

export async function sendPostgresMessage(
  database: Sql,
  tenantId: TenantId,
  command: SendMessageCommand,
  now: Instant,
): Promise<SendMessageResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<SendMessageResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await requirePostgresAgents(transaction, tenantId, command.senderId, command.recipientId);
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      command.recipientId.value,
    ]);
    const messageId: MessageId = MessageId.generate();
    const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
    const createdAt: string = now.toISOString();
    const expiresAt: string = now.addDays(RETENTION_DAYS).toISOString();
    const idempotencyKey: string | null =
      command.idempotencyKey === null ? null : command.idempotencyKey.value;
    const repositoryName: string | null =
      command.repositoryName === null ? null : command.repositoryName.value;
    const branchName: string | null = command.branchName === null ? null : command.branchName.value;
    const clientName: string | null = command.client === null ? null : command.client.value;
    const rawInsertedRows: unknown = await transaction`
      INSERT INTO murmur.messages(
        tenant_id, message_id, thread_id, sender_id, recipient_id, content,
        repository_name, branch_name, client_name, idempotency_key, created_at, expires_at
      )
      VALUES (
        ${tenantId.value}::uuid, ${messageId.value}::uuid, ${threadId.value},
        ${command.senderId.value}, ${command.recipientId.value}, ${command.content.value},
        ${repositoryName}, ${branchName}, ${clientName}, ${idempotencyKey},
        ${createdAt}::timestamptz, ${expiresAt}::timestamptz
      )
      ON CONFLICT(tenant_id, sender_id, idempotency_key) DO NOTHING
      RETURNING
        tenant_sequence AS sequence, message_id::text AS message_id,
        broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
        content, repository_name, branch_name, client_name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        CASE WHEN read_at IS NULL THEN NULL
          ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS read_at
    `;
    const insertedRows: MessageRow[] = z.array(MessageRowSchema).parse(rawInsertedRows);
    const insertedRow: MessageRow | undefined = insertedRows[0];
    if (insertedRow !== undefined) {
      await transaction`
        UPDATE murmur.agents
        SET last_seen_at = ${createdAt}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${command.senderId.value}
      `;
      return { duplicate: false, message: mapMessageRow(insertedRow) };
    }
    if (command.idempotencyKey === null) {
      throw new Error("Message insert returned no row without an idempotency key");
    }
    const rawExistingRows: unknown = await transaction`
      SELECT
        tenant_sequence AS sequence, message_id::text AS message_id,
        broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
        content, repository_name, branch_name, client_name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        CASE WHEN read_at IS NULL THEN NULL
          ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS read_at
      FROM murmur.messages
      WHERE tenant_id = ${tenantId.value}::uuid
        AND sender_id = ${command.senderId.value}
        AND idempotency_key = ${command.idempotencyKey.value}
    `;
    const existingRows: MessageRow[] = z.array(MessageRowSchema).parse(rawExistingRows);
    const existing: Message = mapMessageRow(firstRow(existingRows, "idempotent message"));
    const sameThread: boolean =
      command.threadId === null || existing.threadId.value === command.threadId.value;
    const sameRequest: boolean =
      existing.recipientId.equals(command.recipientId) &&
      existing.content.value === command.content.value &&
      ((existing.branchName === null && command.branchName === null) ||
        (existing.branchName !== null &&
          command.branchName !== null &&
          existing.branchName.equals(command.branchName))) &&
      ((existing.client === null && command.client === null) ||
        (existing.client !== null &&
          command.client !== null &&
          existing.client.equals(command.client))) &&
      ((existing.repositoryName === null && command.repositoryName === null) ||
        (existing.repositoryName !== null &&
          command.repositoryName !== null &&
          existing.repositoryName.equals(command.repositoryName))) &&
      sameThread;
    if (!sameRequest) throw new IdempotencyConflictError(command.idempotencyKey.value);
    return { duplicate: true, message: existing };
  });
}
