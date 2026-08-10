import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { AgentClosedError, IdempotencyConflictError } from "../domain/errors.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import type { Agent, Message, SendMessageCommand, SendMessageResult } from "../domain/models.js";
import { type Instant, MessageId, type TenantId, ThreadId } from "../domain/value-objects.js";
import {
  postgresAgentInTransaction,
  renewPostgresSessionInTransaction,
} from "./postgres-agent-lifecycle-store.js";
import {
  firstRow,
  type MessageRow,
  MessageRowSchema,
  mapMessageRow,
} from "./postgres-message-rows.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

function sameNullableValue(
  existing: { readonly value: string } | null,
  requested: { readonly value: string } | null,
): boolean {
  return existing === null
    ? requested === null
    : requested !== null && existing.value === requested.value;
}

function matchesRequest(existing: Message, command: SendMessageCommand): boolean {
  return (
    existing.recipientId.equals(command.recipientId) &&
    existing.content.value === command.content.value &&
    sameNullableValue(existing.branchName, command.branchName) &&
    sameNullableValue(existing.client, command.client) &&
    sameNullableValue(existing.repositoryName, command.repositoryName) &&
    (command.threadId === null || existing.threadId.value === command.threadId.value)
  );
}

async function existingMessage(
  transaction: TransactionSql,
  tenantId: TenantId,
  command: SendMessageCommand,
): Promise<Message | null> {
  if (command.idempotencyKey === null) return null;
  const raw: unknown = await transaction`
    SELECT
      tenant_sequence AS sequence, message_id::text AS message_id,
      broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
      sender_generation, recipient_generation,
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
  const rows: MessageRow[] = z.array(MessageRowSchema).parse(raw);
  if (rows.length === 0) return null;
  const message: Message = mapMessageRow(firstRow(rows, "idempotent message"));
  if (!matchesRequest(message, command)) {
    throw new IdempotencyConflictError(command.idempotencyKey.value);
  }
  return message;
}

export async function sendPostgresMessage(
  database: Sql,
  tenantId: TenantId,
  command: SendMessageCommand,
  now: Instant,
): Promise<SendMessageResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<SendMessageResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      command.senderId.value,
      command.recipientId.value,
    ]);
    const prior: Message | null = await existingMessage(transaction, tenantId, command);
    if (prior !== null) {
      const recipient: Agent = await postgresAgentInTransaction(
        transaction,
        tenantId,
        prior.recipientId,
        now,
      );
      return {
        duplicate: true,
        message: prior,
        recipientLastSeenAt: recipient.lastSeenAt,
        recipientState: recipient.state,
      };
    }

    const sender: Agent = await renewPostgresSessionInTransaction(
      transaction,
      tenantId,
      command.senderId,
      command.sessionKey ?? SessionKey.default(),
      now,
      true,
    );
    const recipient: Agent = await postgresAgentInTransaction(
      transaction,
      tenantId,
      command.recipientId,
      now,
    );
    if (recipient.state === "closed") throw new AgentClosedError(command.recipientId.value);

    const messageId: MessageId = MessageId.generate();
    const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
    const idempotencyKey: string | null =
      command.idempotencyKey === null ? null : command.idempotencyKey.value;
    const raw: unknown = await transaction`
      INSERT INTO murmur.messages(
        tenant_id, message_id, thread_id, sender_id, recipient_id,
        sender_generation, recipient_generation, content,
        repository_name, branch_name, client_name, idempotency_key, created_at, expires_at
      ) VALUES (
        ${tenantId.value}::uuid, ${messageId.value}::uuid, ${threadId.value},
        ${command.senderId.value}, ${command.recipientId.value},
        ${sender.generation.value}, ${recipient.generation.value}, ${command.content.value},
        ${command.repositoryName === null ? null : command.repositoryName.value},
        ${command.branchName === null ? null : command.branchName.value},
        ${command.client === null ? null : command.client.value}, ${idempotencyKey},
        ${now.toISOString()}::timestamptz,
        ${now.addDays(RETENTION_DAYS).toISOString()}::timestamptz
      )
      RETURNING
        tenant_sequence AS sequence, message_id::text AS message_id,
        broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
        sender_generation, recipient_generation,
        content, repository_name, branch_name, client_name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        CASE WHEN read_at IS NULL THEN NULL
          ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS read_at
    `;
    const rows: MessageRow[] = z.array(MessageRowSchema).parse(raw);
    return {
      duplicate: false,
      message: mapMessageRow(firstRow(rows, "inserted message")),
      recipientLastSeenAt: recipient.lastSeenAt,
      recipientState: recipient.state,
    };
  });
}
