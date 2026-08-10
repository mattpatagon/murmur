import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type {
  Agent,
  GetMessagesQuery,
  MarkMessagesReadCommand,
  MarkMessagesReadResult,
  Message,
} from "../domain/models.js";
import type { AgentGeneration } from "../domain/lifecycle-values.js";
import {
  type AgentId,
  type Instant,
  type MessageId,
  Sequence,
  type TenantId,
} from "../domain/value-objects.js";
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
  return await database.begin(async (transaction: TransactionSql): Promise<readonly Message[]> => {
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
    const raw: unknown = await transaction`
      SELECT
        tenant_sequence AS sequence, message_id::text AS message_id,
        broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
        sender_generation, recipient_generation,
        content, sender_authority, message_kind,
        orchestrator_policy_id::text AS orchestrator_policy_id,
        repository_name, branch_name, client_name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        CASE WHEN read_at IS NULL THEN NULL
          ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS read_at
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
    `;
    const rows: MessageRow[] = z.array(MessageRowSchema).parse(raw);
    return rows.map((row: MessageRow): Message => mapMessageRow(row));
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
    const raw: unknown = await transaction`
      SELECT COALESCE(MAX(tenant_sequence), 0)::bigint AS version
      FROM murmur.messages
      WHERE tenant_id = ${tenantId.value}::uuid
        AND recipient_id = ${agentId.value}
        AND recipient_generation = ${generation === null ? agent.generation.value : generation.value}
        AND expires_at > ${now.toISOString()}::timestamptz
    `;
    const rows: { readonly version: number }[] = z.array(InboxVersionRowSchema).parse(raw);
    return Sequence.parse(firstRow(rows, "inbox version").version);
  });
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
