import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

import { broadcastRequestMatches } from "../domain/broadcasts.js";
import { RETENTION_DAYS } from "../domain/contracts.js";
import { IdempotencyConflictError } from "../domain/errors.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import type { Agent, BroadcastMessageCommand, BroadcastMessageResult } from "../domain/models.js";
import {
  BroadcastId,
  Instant,
  MachineName,
  MessageId,
  RepositoryName,
  ThreadId,
} from "../domain/value-objects.js";
import { renewSqliteSession } from "./sqlite-agent-lifecycle-store.js";
import { type BroadcastRow, BroadcastRowSchema, CountRowSchema } from "./sqlite-message-rows.js";

const MAX_BROADCAST_RECIPIENTS: number = 100;
type RecipientRow = { readonly agent_id: string; readonly generation: number };
const RecipientRowSchema: z.ZodType<RecipientRow> = z.strictObject({
  agent_id: z.string(),
  generation: z
    .union([z.number().int(), z.bigint()])
    .transform((value: number | bigint): number => Number(value)),
});

function broadcastRecipientCount(database: Database, broadcastId: BroadcastId): number {
  const statement: Statement<unknown, [string]> = database.query(`
    SELECT COUNT(*) AS count FROM messages WHERE broadcast_id = ?
  `);
  return CountRowSchema.parse(statement.get(broadcastId.value)).count;
}

function broadcastResult(
  database: Database,
  row: BroadcastRow,
  duplicate: boolean,
): BroadcastMessageResult {
  const broadcastId: BroadcastId = BroadcastId.parse(row.broadcast_id);
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
    recipientCount: broadcastRecipientCount(database, broadcastId),
    threadId: ThreadId.parse(row.thread_id),
  };
}

function existingBroadcastResult(
  database: Database,
  command: BroadcastMessageCommand,
): BroadcastMessageResult | null {
  if (command.idempotencyKey === null) return null;
  const rawRow: unknown = database
    .query<unknown, [string, string]>(`
      SELECT * FROM broadcasts WHERE sender_id = ? AND idempotency_key = ?
    `)
    .get(command.senderId.value, command.idempotencyKey.value);
  if (rawRow === null) return null;
  const row: BroadcastRow = BroadcastRowSchema.parse(rawRow);
  const matches: boolean = broadcastRequestMatches(
    {
      audienceMachineName: row.audience_machine_name,
      audienceRepositoryName: row.audience_repository_name,
      branchName: row.branch_name,
      clientName: row.client_name,
      content: row.content,
      repositoryName: row.repository_name,
      threadId: row.thread_id,
    },
    command,
  );
  if (!matches) throw new IdempotencyConflictError(command.idempotencyKey.value);
  return broadcastResult(database, row, true);
}

function activeRecipients(
  database: Database,
  command: BroadcastMessageCommand,
  now: Instant,
): readonly RecipientRow[] {
  const audienceRepository: string | null =
    command.audience.repositoryName === null ? null : command.audience.repositoryName.value;
  const audienceMachine: string | null =
    command.audience.machineName === null ? null : command.audience.machineName.value;
  const rows: unknown[] = database
    .query<
      unknown,
      [string, string, string | null, string | null, string | null, string | null, number]
    >(`
      SELECT agent.agent_id, agent.generation
      FROM agents AS agent
      WHERE agent.agent_id <> ?
        AND agent.closed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM agent_sessions AS session
          WHERE session.agent_id = agent.agent_id
            AND session.generation = agent.generation
            AND session.ended_at IS NULL
            AND session.lease_expires_at > ?
        )
        AND (? IS NULL OR json_extract(agent.metadata_json, '$.repository') = ?)
        AND (? IS NULL OR json_extract(agent.metadata_json, '$.machine') = ?)
      ORDER BY agent.agent_id ASC
      LIMIT ?
    `)
    .all(
      command.senderId.value,
      now.toISOString(),
      audienceRepository,
      audienceRepository,
      audienceMachine,
      audienceMachine,
      MAX_BROADCAST_RECIPIENTS + 1,
    );
  const recipients: RecipientRow[] = rows.map(
    (row: unknown): RecipientRow => RecipientRowSchema.parse(row),
  );
  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`Broadcasts are limited to ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  return recipients;
}

function insertRecipients(
  database: Database,
  command: BroadcastMessageCommand,
  broadcastId: BroadcastId,
  threadId: ThreadId,
  sender: Agent,
  recipients: readonly RecipientRow[],
  now: Instant,
): void {
  if (command.repositoryName === null || command.branchName === null || command.client === null) {
    throw new Error("Broadcast message context must include repository, branch, and client");
  }
  const insert: Statement<
    unknown,
    [
      string,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
  > = database.query(`
    INSERT INTO messages(
      message_id, thread_id, sender_id, recipient_id,
      sender_generation, recipient_generation, broadcast_id, content,
      repository_name, branch_name, client_name, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const recipient of recipients) {
    insert.run(
      MessageId.generate().value,
      threadId.value,
      command.senderId.value,
      recipient.agent_id,
      sender.generation.value,
      recipient.generation,
      broadcastId.value,
      command.content.value,
      command.repositoryName.value,
      command.branchName.value,
      command.client.value,
      now.toISOString(),
      now.addDays(RETENTION_DAYS).toISOString(),
    );
  }
}

export function broadcastSqliteMessage(
  database: Database,
  command: BroadcastMessageCommand,
  now: Instant,
): BroadcastMessageResult {
  if (command.repositoryName === null || command.branchName === null || command.client === null) {
    throw new Error("Broadcast message context must include repository, branch, and client");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing: BroadcastMessageResult | null = existingBroadcastResult(database, command);
    if (existing !== null) {
      database.exec("COMMIT");
      return existing;
    }
    const sender: Agent = renewSqliteSession(
      database,
      command.senderId,
      command.sessionKey ?? SessionKey.default(),
      now,
      true,
    );
    const recipients: readonly RecipientRow[] = activeRecipients(database, command, now);
    const broadcastId: BroadcastId = BroadcastId.generate();
    const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
    const audienceRepository: string | null =
      command.audience.repositoryName === null ? null : command.audience.repositoryName.value;
    const audienceMachine: string | null =
      command.audience.machineName === null ? null : command.audience.machineName.value;
    const idempotencyKey: string | null =
      command.idempotencyKey === null ? null : command.idempotencyKey.value;
    database
      .query<
        unknown,
        [
          string,
          string,
          string,
          number,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string,
          string,
        ]
      >(`
        INSERT INTO broadcasts(
          broadcast_id, thread_id, sender_id, sender_generation, content,
          repository_name, branch_name, client_name,
          audience_repository_name, audience_machine_name, idempotency_key,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        broadcastId.value,
        threadId.value,
        command.senderId.value,
        sender.generation.value,
        command.content.value,
        command.repositoryName.value,
        command.branchName.value,
        command.client.value,
        audienceRepository,
        audienceMachine,
        idempotencyKey,
        now.toISOString(),
        now.addDays(RETENTION_DAYS).toISOString(),
      );
    insertRecipients(database, command, broadcastId, threadId, sender, recipients, now);
    const storedRow: unknown = database
      .query<unknown, [string]>("SELECT * FROM broadcasts WHERE broadcast_id = ?")
      .get(broadcastId.value);
    const row: BroadcastRow = BroadcastRowSchema.parse(storedRow);
    database.exec("COMMIT");
    return broadcastResult(database, row, false);
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
