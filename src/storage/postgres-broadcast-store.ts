import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { broadcastRequestMatches } from "../domain/broadcasts.js";
import { ACTIVE_AGENT_WINDOW_MINUTES, RETENTION_DAYS } from "../domain/contracts.js";
import { IdempotencyConflictError, UnknownAgentError } from "../domain/errors.js";
import type { BroadcastMessageCommand, BroadcastMessageResult } from "../domain/models.js";
import {
  type AgentId,
  BroadcastId,
  Instant,
  MachineName,
  MessageId,
  RepositoryName,
  type TenantId,
  ThreadId,
} from "../domain/value-objects.js";
import {
  AgentIdRowSchema,
  type BroadcastRow,
  BroadcastRowSchema,
  type CountRow,
  CountRowSchema,
  firstRow,
  minutesBefore,
} from "./postgres-message-rows.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

const MAX_BROADCAST_RECIPIENTS: number = 100;
type AgentIdRow = { readonly agent_id: string };

async function requireBroadcastSender(
  transaction: TransactionSql,
  tenantId: TenantId,
  senderId: AgentId,
): Promise<void> {
  const rawRows: unknown = await transaction`
    SELECT agent_id
    FROM murmur.agents
    WHERE tenant_id = ${tenantId.value}::uuid
      AND agent_id = ${senderId.value}
  `;
  const rows: AgentIdRow[] = z.array(AgentIdRowSchema).parse(rawRows);
  if (rows.length === 0) throw new UnknownAgentError(senderId.value);
}

async function activeBroadcastRecipients(
  transaction: TransactionSql,
  tenantId: TenantId,
  senderId: AgentId,
  activeSince: string,
  repositoryName: string | null,
  machineName: string | null,
): Promise<readonly AgentIdRow[]> {
  let rawRows: unknown;
  if (repositoryName !== null && machineName !== null) {
    rawRows = await transaction`
      SELECT agent_id
      FROM murmur.agents
      WHERE tenant_id = ${tenantId.value}::uuid
        AND agent_id <> ${senderId.value}
        AND last_seen_at >= ${activeSince}::timestamptz
        AND metadata ->> 'repository' = ${repositoryName}
        AND metadata ->> 'machine' = ${machineName}
      ORDER BY agent_id ASC
      LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
    `;
  } else if (repositoryName !== null) {
    rawRows = await transaction`
      SELECT agent_id
      FROM murmur.agents
      WHERE tenant_id = ${tenantId.value}::uuid
        AND agent_id <> ${senderId.value}
        AND last_seen_at >= ${activeSince}::timestamptz
        AND metadata ->> 'repository' = ${repositoryName}
      ORDER BY agent_id ASC
      LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
    `;
  } else if (machineName !== null) {
    rawRows = await transaction`
      SELECT agent_id
      FROM murmur.agents
      WHERE tenant_id = ${tenantId.value}::uuid
        AND agent_id <> ${senderId.value}
        AND last_seen_at >= ${activeSince}::timestamptz
        AND metadata ->> 'machine' = ${machineName}
      ORDER BY agent_id ASC
      LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
    `;
  } else {
    rawRows = await transaction`
      SELECT agent_id
      FROM murmur.agents
      WHERE tenant_id = ${tenantId.value}::uuid
        AND agent_id <> ${senderId.value}
        AND last_seen_at >= ${activeSince}::timestamptz
      ORDER BY agent_id ASC
      LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
    `;
  }
  const rows: AgentIdRow[] = z.array(AgentIdRowSchema).parse(rawRows);
  if (rows.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`Broadcasts are limited to ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  return rows;
}

async function broadcastResult(
  transaction: TransactionSql,
  tenantId: TenantId,
  row: BroadcastRow,
  duplicate: boolean,
): Promise<BroadcastMessageResult> {
  const broadcastId: BroadcastId = BroadcastId.parse(row.broadcast_id);
  const rawCountRows: unknown = await transaction`
    SELECT COUNT(*) AS count
    FROM murmur.messages
    WHERE tenant_id = ${tenantId.value}::uuid
      AND broadcast_id = ${broadcastId.value}::uuid
  `;
  const countRows: CountRow[] = z.array(CountRowSchema).parse(rawCountRows);
  return {
    audience: {
      machineName:
        row.audience_machine_name === null ? null : MachineName.parse(row.audience_machine_name),
      repositoryName:
        row.audience_repository_name === null
          ? null
          : RepositoryName.parse(row.audience_repository_name),
    },
    broadcastId,
    createdAt: Instant.parse(row.created_at),
    duplicate,
    expiresAt: Instant.parse(row.expires_at),
    recipientCount: firstRow(countRows, "broadcast recipient count").count,
    threadId: ThreadId.parse(row.thread_id),
  };
}

async function existingBroadcastResult(
  transaction: TransactionSql,
  tenantId: TenantId,
  command: BroadcastMessageCommand,
): Promise<BroadcastMessageResult> {
  if (command.idempotencyKey === null) {
    throw new Error("Broadcast insert returned no row without an idempotency key");
  }
  const rawRows: unknown = await transaction`
    SELECT
      broadcast_id::text AS broadcast_id,
      thread_id,
      sender_id,
      content,
      repository_name,
      branch_name,
      client_name,
      audience_repository_name,
      audience_machine_name,
      idempotency_key,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
    FROM murmur.broadcasts
    WHERE tenant_id = ${tenantId.value}::uuid
      AND sender_id = ${command.senderId.value}
      AND idempotency_key = ${command.idempotencyKey.value}
  `;
  const rows: BroadcastRow[] = z.array(BroadcastRowSchema).parse(rawRows);
  const existing: BroadcastRow = firstRow(rows, "idempotent broadcast");
  const matches: boolean = broadcastRequestMatches(
    {
      audienceMachineName: existing.audience_machine_name,
      audienceRepositoryName: existing.audience_repository_name,
      branchName: existing.branch_name,
      clientName: existing.client_name,
      content: existing.content,
      repositoryName: existing.repository_name,
      threadId: existing.thread_id,
    },
    command,
  );
  if (!matches) throw new IdempotencyConflictError(command.idempotencyKey.value);
  return await broadcastResult(transaction, tenantId, existing, true);
}

export async function broadcastPostgresMessage(
  database: Sql,
  tenantId: TenantId,
  command: BroadcastMessageCommand,
  now: Instant,
): Promise<BroadcastMessageResult> {
  if (command.repositoryName === null || command.branchName === null || command.client === null) {
    throw new Error("Broadcast message context must include repository, branch, and client");
  }
  const repositoryName: string = command.repositoryName.value;
  const branchName: string = command.branchName.value;
  const clientName: string = command.client.value;
  return await database.begin(
    async (transaction: TransactionSql): Promise<BroadcastMessageResult> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requireBroadcastSender(transaction, tenantId, command.senderId);
      const broadcastId: BroadcastId = BroadcastId.generate();
      const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
      const createdAt: string = now.toISOString();
      const expiresAt: string = now.addDays(RETENTION_DAYS).toISOString();
      const audienceRepository: string | null =
        command.audience.repositoryName === null ? null : command.audience.repositoryName.value;
      const audienceMachine: string | null =
        command.audience.machineName === null ? null : command.audience.machineName.value;
      const idempotencyKey: string | null =
        command.idempotencyKey === null ? null : command.idempotencyKey.value;
      const rawInsertedRows: unknown = await transaction`
        INSERT INTO murmur.broadcasts(
          tenant_id, broadcast_id, thread_id, sender_id, content,
          repository_name, branch_name, client_name, audience_repository_name,
          audience_machine_name, idempotency_key, created_at, expires_at
        )
        VALUES (
          ${tenantId.value}::uuid, ${broadcastId.value}::uuid, ${threadId.value},
          ${command.senderId.value}, ${command.content.value}, ${repositoryName},
          ${branchName}, ${clientName}, ${audienceRepository}, ${audienceMachine},
          ${idempotencyKey}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
        )
        ON CONFLICT(tenant_id, sender_id, idempotency_key) DO NOTHING
        RETURNING
          broadcast_id::text AS broadcast_id, thread_id, sender_id, content,
          repository_name, branch_name, client_name, audience_repository_name,
          audience_machine_name, idempotency_key,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
      `;
      const insertedRows: BroadcastRow[] = z.array(BroadcastRowSchema).parse(rawInsertedRows);
      const inserted: BroadcastRow | undefined = insertedRows[0];
      if (inserted === undefined) {
        return await existingBroadcastResult(transaction, tenantId, command);
      }

      const activeSince: string = minutesBefore(now, ACTIVE_AGENT_WINDOW_MINUTES).toISOString();
      const recipients: readonly AgentIdRow[] = await activeBroadcastRecipients(
        transaction,
        tenantId,
        command.senderId,
        activeSince,
        audienceRepository,
        audienceMachine,
      );
      if (recipients.length > 0) {
        const messageIds: string[] = recipients.map((): string => MessageId.generate().value);
        const recipientIds: string[] = recipients.map(
          (recipient: AgentIdRow): string => recipient.agent_id,
        );
        await lockPostgresRecipientCommitOrder(database, transaction, tenantId, recipientIds);
        await transaction`
          INSERT INTO murmur.messages(
            tenant_id, message_id, thread_id, sender_id, recipient_id, broadcast_id,
            content, repository_name, branch_name, client_name, created_at, expires_at
          )
          SELECT
            ${tenantId.value}::uuid, delivery.message_id, ${threadId.value},
            ${command.senderId.value}, delivery.recipient_id, ${broadcastId.value}::uuid,
            ${command.content.value}, ${repositoryName}, ${branchName}, ${clientName},
            ${createdAt}::timestamptz, ${expiresAt}::timestamptz
          FROM unnest(
            ${database.array(messageIds)}::uuid[],
            ${database.array(recipientIds)}::text[]
          ) AS delivery(message_id, recipient_id)
        `;
      }
      await transaction`
        UPDATE murmur.agents
        SET last_seen_at = ${createdAt}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${command.senderId.value}
      `;
      return await broadcastResult(transaction, tenantId, inserted, false);
    },
  );
}
