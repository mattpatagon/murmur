import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type {
  GetMessagesQuery,
  MarkMessagesReadCommand,
  MarkMessagesReadResult,
  Message,
} from "../domain/models.js";
import {
  type AgentId,
  type Instant,
  type MessageId,
  Sequence,
  type TenantId,
} from "../domain/value-objects.js";
import {
  type CountRow,
  CountRowSchema,
  firstRow,
  InboxVersionRowSchema,
  MessageIdRowSchema,
  type MessageRow,
  MessageRowSchema,
  mapMessageRow,
} from "./postgres-message-rows.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

export async function getPostgresMessages(
  database: Sql,
  tenantId: TenantId,
  query: GetMessagesQuery,
  now: Instant,
): Promise<readonly Message[]> {
  const threadId: string | null = query.threadId === null ? null : query.threadId.value;
  const rawRows: unknown = await database.begin(
    async (transaction: TransactionSql): Promise<unknown> => {
      await setPostgresTenantContext(transaction, tenantId);
      return await transaction`
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
          AND recipient_id = ${query.agentId.value}
          AND tenant_sequence > ${query.afterSequence.value}
          AND expires_at > ${now.toISOString()}::timestamptz
          AND (${query.unreadOnly} = false OR read_at IS NULL)
          AND (${threadId}::text IS NULL OR thread_id = ${threadId})
        ORDER BY tenant_sequence ASC
        LIMIT ${query.limit}
      `;
    },
  );
  const rows: MessageRow[] = z.array(MessageRowSchema).parse(rawRows);
  return rows.map((row: MessageRow): Message => mapMessageRow(row));
}

export async function markPostgresMessagesRead(
  database: Sql,
  tenantId: TenantId,
  command: MarkMessagesReadCommand,
  now: Instant,
): Promise<MarkMessagesReadResult> {
  if (command.messageIds.length === 0) return { readAt: now, updated: 0 };
  const messageIds: string[] = command.messageIds.map(
    (messageId: MessageId): string => messageId.value,
  );
  const rawRows: unknown = await database.begin(
    async (transaction: TransactionSql): Promise<unknown> => {
      await setPostgresTenantContext(transaction, tenantId);
      return await transaction`
        UPDATE murmur.messages
        SET read_at = COALESCE(read_at, ${now.toISOString()}::timestamptz)
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${command.agentId.value}
          AND message_id = ANY(${database.array(messageIds)}::uuid[])
          AND expires_at > ${now.toISOString()}::timestamptz
        RETURNING message_id::text AS message_id
      `;
    },
  );
  const rows: { readonly message_id: string }[] = z.array(MessageIdRowSchema).parse(rawRows);
  return { readAt: now, updated: rows.length };
}

export async function getPostgresInboxVersion(
  database: Sql,
  tenantId: TenantId,
  agentId: AgentId,
  now: Instant,
): Promise<Sequence> {
  const rawRows: unknown = await database.begin(
    async (transaction: TransactionSql): Promise<unknown> => {
      await setPostgresTenantContext(transaction, tenantId);
      return await transaction`
        SELECT COALESCE(MAX(tenant_sequence), 0) AS version
        FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${agentId.value}
          AND expires_at > ${now.toISOString()}::timestamptz
      `;
    },
  );
  const rows: { readonly version: number }[] = z.array(InboxVersionRowSchema).parse(rawRows);
  return Sequence.parse(firstRow(rows, "inbox version").version);
}

export async function pruneExpiredPostgresMessages(
  database: Sql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  return await database.begin(async (transaction: TransactionSql): Promise<number> => {
    await setPostgresTenantContext(transaction, tenantId);
    const rawRows: unknown = await transaction`
      WITH expired AS (
        SELECT tenant_id, tenant_sequence
        FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND expires_at <= ${now.toISOString()}::timestamptz
        ORDER BY tenant_sequence
        LIMIT 1000
      ), deleted AS (
        DELETE FROM murmur.messages AS message
        USING expired
        WHERE message.tenant_id = expired.tenant_id
          AND message.tenant_sequence = expired.tenant_sequence
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `;
    await transaction`
      DELETE FROM murmur.broadcasts AS broadcast
      USING (
        SELECT tenant_id, broadcast_id
        FROM murmur.broadcasts
        WHERE tenant_id = ${tenantId.value}::uuid
          AND expires_at <= ${now.toISOString()}::timestamptz
        ORDER BY expires_at, broadcast_id
        LIMIT 1000
      ) AS expired
      WHERE broadcast.tenant_id = expired.tenant_id
        AND broadcast.broadcast_id = expired.broadcast_id
    `;
    const rows: CountRow[] = z.array(CountRowSchema).parse(rawRows);
    return firstRow(rows, "expiration count").count;
  });
}
