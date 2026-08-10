import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { broadcastRequestMatches } from "../domain/broadcasts.js";
import { RETENTION_DAYS } from "../domain/contracts.js";
import { AgentAuthorityError, IdempotencyConflictError } from "../domain/errors.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import type { Agent, BroadcastMessageCommand, BroadcastMessageResult } from "../domain/models.js";
import type { SenderAuthority } from "../domain/orchestration.js";
import {
  BroadcastId,
  Instant,
  MachineName,
  MessageId,
  RepositoryName,
  type TenantId,
  ThreadId,
} from "../domain/value-objects.js";
import { renewPostgresSessionInTransaction } from "./postgres-agent-lifecycle-store.js";
import {
  type BroadcastRow,
  BroadcastRowSchema,
  type CountRow,
  CountRowSchema,
  firstRow,
} from "./postgres-message-rows.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

const MAX_BROADCAST_RECIPIENTS: number = 100;
type RecipientRow = { readonly agent_id: string; readonly generation: number };
const RecipientRowSchema: z.ZodType<RecipientRow> = z.strictObject({
  agent_id: z.string(),
  generation: z.number().int().positive(),
});

async function broadcastResult(
  transaction: TransactionSql,
  tenantId: TenantId,
  row: BroadcastRow,
  duplicate: boolean,
): Promise<BroadcastMessageResult> {
  const broadcastId: BroadcastId = BroadcastId.parse(row.broadcast_id);
  const rawCount: unknown = await transaction`
    SELECT COUNT(*)::int AS count FROM murmur.messages
    WHERE tenant_id = ${tenantId.value}::uuid
      AND broadcast_id = ${broadcastId.value}::uuid
  `;
  const counts: CountRow[] = z.array(CountRowSchema).parse(rawCount);
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
    recipientCount: firstRow(counts, "broadcast recipient count").count,
    threadId: ThreadId.parse(row.thread_id),
  };
}

async function existingBroadcast(
  transaction: TransactionSql,
  tenantId: TenantId,
  command: BroadcastMessageCommand,
): Promise<BroadcastRow | null> {
  if (command.idempotencyKey === null) return null;
  const raw: unknown = await transaction`
    SELECT
      broadcast_id::text AS broadcast_id,
      thread_id,
      sender_id,
      sender_generation,
      sender_authority,
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
  const rows: BroadcastRow[] = z.array(BroadcastRowSchema).parse(raw);
  const row: BroadcastRow | undefined = rows[0];
  if (row === undefined) return null;
  const matches: boolean = broadcastRequestMatches(
    {
      audienceMachineName: row.audience_machine_name,
      audienceRepositoryName: row.audience_repository_name,
      branchName: row.branch_name,
      clientName: row.client_name,
      content: row.content,
      repositoryName: row.repository_name,
      senderAuthority: row.sender_authority,
      threadId: row.thread_id,
    },
    command,
  );
  if (!matches) throw new IdempotencyConflictError(command.idempotencyKey.value);
  return row;
}

async function candidateRecipients(
  transaction: TransactionSql,
  tenantId: TenantId,
  command: BroadcastMessageCommand,
  now: Instant,
): Promise<readonly RecipientRow[]> {
  const repository: string | null =
    command.audience.repositoryName === null ? null : command.audience.repositoryName.value;
  const machine: string | null =
    command.audience.machineName === null ? null : command.audience.machineName.value;
  const raw: unknown = await transaction`
    SELECT agent.agent_id, agent.generation
    FROM murmur.agents AS agent
    WHERE agent.tenant_id = ${tenantId.value}::uuid
      AND agent.agent_id <> ${command.senderId.value}
      AND agent.closed_at IS NULL
      AND (${repository}::text IS NULL OR agent.metadata ->> 'repository' = ${repository})
      AND (${machine}::text IS NULL OR agent.metadata ->> 'machine' = ${machine})
      AND EXISTS (
        SELECT 1 FROM murmur.agent_sessions AS session
        WHERE session.tenant_id = agent.tenant_id
          AND session.agent_id = agent.agent_id
          AND session.generation = agent.generation
          AND session.ended_at IS NULL
          AND session.lease_expires_at > ${now.toISOString()}::timestamptz
      )
    ORDER BY agent.agent_id ASC
    LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
  `;
  const rows: RecipientRow[] = z.array(RecipientRowSchema).parse(raw);
  if (rows.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`Broadcasts are limited to ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  return rows;
}

async function currentRecipients(
  transaction: TransactionSql,
  tenantId: TenantId,
  ids: readonly string[],
  now: Instant,
): Promise<readonly RecipientRow[]> {
  if (ids.length === 0) return [];
  const currentRaw: unknown = await transaction`
    SELECT agent.agent_id, agent.generation
    FROM murmur.agents AS agent
    WHERE agent.tenant_id = ${tenantId.value}::uuid
      AND agent.agent_id = ANY(${transaction.array(Array.from(ids))}::text[])
      AND agent.closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM murmur.agent_sessions AS session
        WHERE session.tenant_id = agent.tenant_id
          AND session.agent_id = agent.agent_id
          AND session.generation = agent.generation
          AND session.ended_at IS NULL
          AND session.lease_expires_at > ${now.toISOString()}::timestamptz
      )
    ORDER BY agent.agent_id ASC
  `;
  return z.array(RecipientRowSchema).parse(currentRaw);
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
  const senderAuthority: SenderAuthority = command.senderAuthority ?? "peer";
  return await database.begin(
    async (transaction: TransactionSql): Promise<BroadcastMessageResult> => {
      await setPostgresTenantContext(transaction, tenantId);
      const prior: BroadcastRow | null = await existingBroadcast(transaction, tenantId, command);
      if (prior !== null) return await broadcastResult(transaction, tenantId, prior, true);
      const candidates: readonly RecipientRow[] = await candidateRecipients(
        transaction,
        tenantId,
        command,
        now,
      );
      const candidateIds: string[] = candidates.map(
        (candidate: RecipientRow): string => candidate.agent_id,
      );
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        command.senderId.value,
        ...candidateIds,
      ]);
      const concurrentPrior: BroadcastRow | null = await existingBroadcast(
        transaction,
        tenantId,
        command,
      );
      if (concurrentPrior !== null) {
        return await broadcastResult(transaction, tenantId, concurrentPrior, true);
      }

      const sender: Agent = await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        command.senderId,
        command.sessionKey ?? SessionKey.default(),
        now,
        true,
      );
      if (sender.authority !== senderAuthority) throw new AgentAuthorityError();
      const recipients: readonly RecipientRow[] = await currentRecipients(
        transaction,
        tenantId,
        candidateIds,
        now,
      );
      const broadcastId: BroadcastId = BroadcastId.generate();
      const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
      const rawInserted: unknown = await transaction`
        INSERT INTO murmur.broadcasts(
          tenant_id, broadcast_id, thread_id, sender_id, sender_generation,
          sender_authority, content,
          repository_name, branch_name, client_name, audience_repository_name,
          audience_machine_name, idempotency_key, created_at, expires_at
        ) VALUES (
          ${tenantId.value}::uuid, ${broadcastId.value}::uuid, ${threadId.value},
          ${command.senderId.value}, ${sender.generation.value}, ${senderAuthority},
          ${command.content.value},
          ${repositoryName}, ${branchName}, ${clientName},
          ${command.audience.repositoryName === null ? null : command.audience.repositoryName.value},
          ${command.audience.machineName === null ? null : command.audience.machineName.value},
          ${command.idempotencyKey === null ? null : command.idempotencyKey.value},
          ${now.toISOString()}::timestamptz,
          ${now.addDays(RETENTION_DAYS).toISOString()}::timestamptz
        )
        RETURNING
          broadcast_id::text AS broadcast_id, thread_id, sender_id, sender_generation,
          sender_authority,
          content, repository_name, branch_name, client_name,
          audience_repository_name, audience_machine_name, idempotency_key,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
      `;
      const insertedRows: BroadcastRow[] = z.array(BroadcastRowSchema).parse(rawInserted);
      if (recipients.length > 0) {
        const messageIds: string[] = recipients.map((): string => MessageId.generate().value);
        await transaction`
          INSERT INTO murmur.messages(
            tenant_id, message_id, thread_id, sender_id, recipient_id,
            sender_generation, recipient_generation, broadcast_id, content,
            sender_authority,
            repository_name, branch_name, client_name, created_at, expires_at
          )
          SELECT
            ${tenantId.value}::uuid, delivery.message_id, ${threadId.value},
            ${command.senderId.value}, delivery.recipient_id,
            ${sender.generation.value}, delivery.recipient_generation,
            ${broadcastId.value}::uuid, ${command.content.value},
            ${senderAuthority},
            ${repositoryName}, ${branchName}, ${clientName},
            ${now.toISOString()}::timestamptz,
            ${now.addDays(RETENTION_DAYS).toISOString()}::timestamptz
          FROM unnest(
            ${database.array(messageIds)}::uuid[],
            ${database.array(recipients.map((row: RecipientRow): string => row.agent_id))}::text[],
            ${database.array(recipients.map((row: RecipientRow): number => row.generation))}::integer[]
          ) AS delivery(message_id, recipient_id, recipient_generation)
        `;
      }
      return await broadcastResult(
        transaction,
        tenantId,
        firstRow(insertedRows, "inserted broadcast"),
        false,
      );
    },
  );
}
