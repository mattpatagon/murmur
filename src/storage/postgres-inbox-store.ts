import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { AgentGeneration } from "../domain/lifecycle-values.js";
import type {
  Agent,
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
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";
import {
  INBOX_PAGE_ROW_OVERHEAD_BYTES,
  MAX_INBOX_PAGE_BYTES,
  PLAINTEXT_PAGE_CONTENT_MULTIPLIER,
  parsePostgresInboxPage,
} from "./inbox-page-budget.js";
import type { InboxReadResult } from "./message-store.js";
import {
  postgresAgentInTransaction,
  renewPostgresSessionInTransaction,
} from "./postgres-agent-lifecycle-store.js";
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

async function readingAgent(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  sessionKey: GetMessagesQuery["sessionKey"] | MarkMessagesReadCommand["sessionKey"],
  now: Instant,
): Promise<Agent> {
  if (sessionKey != null) {
    return await renewPostgresSessionInTransaction(
      transaction,
      tenantId,
      agentId,
      sessionKey,
      now,
      false,
    );
  }
  return await postgresAgentInTransaction(transaction, tenantId, agentId, now);
}

export async function getPostgresMessages(
  database: Sql,
  tenantId: TenantId,
  query: GetMessagesQuery,
  now: Instant,
): Promise<readonly Message[]> {
  return (await readPostgresInbox(database, tenantId, query, now, false)).messages;
}

export async function getPostgresMessagesWithVersion(
  database: Sql,
  tenantId: TenantId,
  query: GetMessagesQuery,
  now: Instant,
): Promise<InboxReadResult> {
  return await readPostgresInbox(database, tenantId, query, now, true);
}

async function readPostgresInbox(
  database: Sql,
  tenantId: TenantId,
  query: GetMessagesQuery,
  now: Instant,
  includeVersion: boolean,
): Promise<InboxReadResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<InboxReadResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    const agent: Agent = await readingAgent(
      transaction,
      tenantId,
      query.agentId,
      query.sessionKey,
      now,
    );
    const generation: number =
      query.generation === null || query.generation === undefined
        ? agent.generation.value
        : query.generation.value;
    const threadId: string | null = query.threadId === null ? null : query.threadId.value;
    const reservation: MaterializationReservation =
      reserveMaterializationBytes(MAX_INBOX_PAGE_BYTES);
    try {
      const raw: unknown = await transaction`
      WITH candidates AS MATERIALIZED (
        SELECT tenant_sequence,
          ${PLAINTEXT_PAGE_CONTENT_MULTIPLIER}::bigint * octet_length(content)
            + ${INBOX_PAGE_ROW_OVERHEAD_BYTES}::bigint AS estimated_bytes
        FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${query.agentId.value}
          AND recipient_generation = ${generation}
          AND tenant_sequence > ${query.afterSequence.value}
          AND expires_at > ${now.toISOString()}::timestamptz
          AND (${query.unreadOnly} = false OR read_at IS NULL)
          AND (${threadId}::text IS NULL OR thread_id = ${threadId})
        ORDER BY tenant_sequence ASC
        LIMIT ${query.limit}
      ), budget AS (
        SELECT COALESCE(SUM(estimated_bytes), 0)::bigint AS estimated_page_bytes FROM candidates
      )
      SELECT
        budget.estimated_page_bytes,
        message.tenant_sequence AS sequence, message.message_id::text AS message_id,
        message.broadcast_id::text AS broadcast_id, message.thread_id, message.sender_id,
        message.recipient_id, message.sender_generation, message.recipient_generation,
        message.content, message.sender_authority, message.message_kind,
        message.orchestrator_policy_id::text AS orchestrator_policy_id,
        message.repository_name, message.branch_name, message.client_name,
        to_char(message.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(message.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        CASE WHEN message.read_at IS NULL THEN NULL
          ELSE to_char(message.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS read_at
      FROM budget
      LEFT JOIN candidates ON budget.estimated_page_bytes <= ${MAX_INBOX_PAGE_BYTES}
      LEFT JOIN murmur.messages AS message
        ON message.tenant_id = ${tenantId.value}::uuid
        AND message.tenant_sequence = candidates.tenant_sequence
      WHERE budget.estimated_page_bytes > ${MAX_INBOX_PAGE_BYTES}
        OR message.tenant_sequence IS NOT NULL
      ORDER BY message.tenant_sequence ASC
    `;
      const {
        estimatedBytes,
        rows,
      }: { readonly estimatedBytes: number; readonly rows: MessageRow[] } = parsePostgresInboxPage(
        raw,
        MessageRowSchema,
        { kind: "plaintext", limit: query.limit },
      );
      const messages: Message[] = rows.map((row: MessageRow): Message => mapMessageRow(row));
      reservation.settle(estimatedBytes);
      const inboxVersion: Sequence = includeVersion
        ? await inboxVersionInTransaction(transaction, tenantId, query.agentId, now, generation)
        : Sequence.zero();
      return { messages, inboxVersion };
    } catch (error: unknown) {
      reservation.fail();
      throw error;
    }
  });
}

export async function markPostgresMessagesRead(
  database: Sql,
  tenantId: TenantId,
  command: MarkMessagesReadCommand,
  now: Instant,
): Promise<MarkMessagesReadResult> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<MarkMessagesReadResult> => {
      await setPostgresTenantContext(transaction, tenantId);
      const agent: Agent = await readingAgent(
        transaction,
        tenantId,
        command.agentId,
        command.sessionKey,
        now,
      );
      if (command.messageIds.length === 0) return { readAt: now, updated: 0 };
      const generation: number =
        command.generation === null || command.generation === undefined
          ? agent.generation.value
          : command.generation.value;
      const messageIds: string[] = command.messageIds.map(
        (messageId: MessageId): string => messageId.value,
      );
      const raw: unknown = await transaction`
      UPDATE murmur.messages
      SET read_at = COALESCE(read_at, ${now.toISOString()}::timestamptz)
      WHERE tenant_id = ${tenantId.value}::uuid
        AND recipient_id = ${command.agentId.value}
        AND recipient_generation = ${generation}
        AND message_id = ANY(${database.array(messageIds)}::uuid[])
        AND expires_at > ${now.toISOString()}::timestamptz
      RETURNING message_id::text AS message_id
    `;
      const rows: { readonly message_id: string }[] = z.array(MessageIdRowSchema).parse(raw);
      return { readAt: now, updated: rows.length };
    },
  );
}

export async function getPostgresInboxVersion(
  database: Sql,
  tenantId: TenantId,
  agentId: AgentId,
  now: Instant,
  generation: AgentGeneration | null = null,
): Promise<Sequence> {
  return await database.begin(async (transaction: TransactionSql): Promise<Sequence> => {
    await setPostgresTenantContext(transaction, tenantId);
    const agent: Agent = await postgresAgentInTransaction(transaction, tenantId, agentId, now);
    return await inboxVersionInTransaction(
      transaction,
      tenantId,
      agentId,
      now,
      generation === null ? agent.generation.value : generation.value,
    );
  });
}

async function inboxVersionInTransaction(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  now: Instant,
  generation: number,
): Promise<Sequence> {
  const raw: unknown = await transaction`
      SELECT COALESCE(MAX(active.tenant_sequence), 0)::bigint AS version
      FROM (
        SELECT tenant_sequence FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${agentId.value}
          AND recipient_generation = ${generation}
          AND expires_at > ${now.toISOString()}::timestamptz
        UNION ALL
        SELECT tenant_sequence FROM murmur.e2ee_messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${agentId.value}
          AND recipient_generation = ${generation}
          AND expires_at > ${now.toISOString()}::timestamptz
      ) AS active
    `;
  const rows: { readonly version: number }[] = z.array(InboxVersionRowSchema).parse(raw);
  return Sequence.parse(firstRow(rows, "inbox version").version);
}

export async function pruneExpiredPostgresMessages(
  database: Sql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  return await database.begin(async (transaction: TransactionSql): Promise<number> => {
    await setPostgresTenantContext(transaction, tenantId);
    const raw: unknown = await transaction`
      WITH expired AS (
        SELECT tenant_id, tenant_sequence FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND expires_at <= ${now.toISOString()}::timestamptz
        ORDER BY tenant_sequence LIMIT 1000
      ), deleted AS (
        DELETE FROM murmur.messages AS message USING expired
        WHERE message.tenant_id = expired.tenant_id
          AND message.tenant_sequence = expired.tenant_sequence
        RETURNING 1
      ) SELECT COUNT(*)::int AS count FROM deleted
    `;
    await transaction`
      DELETE FROM murmur.broadcasts AS broadcast
      USING (
        SELECT tenant_id, broadcast_id FROM murmur.broadcasts
        WHERE tenant_id = ${tenantId.value}::uuid
          AND expires_at <= ${now.toISOString()}::timestamptz
        ORDER BY expires_at, broadcast_id LIMIT 1000
      ) AS expired
      WHERE broadcast.tenant_id = expired.tenant_id
        AND broadcast.broadcast_id = expired.broadcast_id
    `;
    const rows: CountRow[] = z.array(CountRowSchema).parse(raw);
    return firstRow(rows, "expiration count").count;
  });
}
