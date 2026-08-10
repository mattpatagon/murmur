import type { Database, Statement } from "bun:sqlite";

import { broadcastRequestMatches } from "../domain/broadcasts.js";
import { ACTIVE_AGENT_WINDOW_MINUTES, RETENTION_DAYS } from "../domain/contracts.js";
import { IdempotencyConflictError } from "../domain/errors.js";
import type { BroadcastMessageCommand, BroadcastMessageResult } from "../domain/models.js";
import {
  AgentId,
  BroadcastId,
  Instant,
  MachineName,
  MessageId,
  RepositoryName,
  ThreadId,
} from "../domain/value-objects.js";
import {
  AgentIdRowSchema,
  type BroadcastRow,
  BroadcastRowSchema,
  CountRowSchema,
  minutesBefore,
} from "./sqlite-message-rows.js";

function broadcastRecipientCount(database: Database, broadcastId: BroadcastId): number {
  const statement: Statement<unknown, [string]> = database.query(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE broadcast_id = ?
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
  const statement: Statement<unknown, [string, string]> = database.query(`
    SELECT * FROM broadcasts WHERE sender_id = ? AND idempotency_key = ?
  `);
  const rawRow: unknown = statement.get(command.senderId.value, command.idempotencyKey.value);
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

function insertRecipients(
  database: Database,
  command: BroadcastMessageCommand,
  broadcastId: BroadcastId,
  threadId: ThreadId,
  now: Instant,
  createdAt: string,
  expiresAt: string,
): void {
  if (command.repositoryName === null || command.branchName === null || command.client === null) {
    throw new Error("Broadcast message context must include repository, branch, and client");
  }
  const audienceRepository: string | null =
    command.audience.repositoryName === null ? null : command.audience.repositoryName.value;
  const audienceMachine: string | null =
    command.audience.machineName === null ? null : command.audience.machineName.value;
  const activeSince: string = minutesBefore(now, ACTIVE_AGENT_WINDOW_MINUTES).toISOString();
  const recipients: Statement<
    unknown,
    [string, string, string | null, string | null, string | null, string | null]
  > = database.query(`
    SELECT agent_id
    FROM agents
    WHERE agent_id <> ?
      AND last_seen_at >= ?
      AND (? IS NULL OR json_extract(metadata_json, '$.repository') = ?)
      AND (? IS NULL OR json_extract(metadata_json, '$.machine') = ?)
    ORDER BY agent_id ASC
  `);
  const recipientIds: AgentId[] = recipients
    .all(
      command.senderId.value,
      activeSince,
      audienceRepository,
      audienceRepository,
      audienceMachine,
      audienceMachine,
    )
    .map((row: unknown): AgentId => AgentId.parse(AgentIdRowSchema.parse(row).agent_id));
  const insert: Statement<
    unknown,
    [string, string, string, string, string, string, string, string, string, string, string]
  > = database.query(`
    INSERT INTO messages(
      message_id, thread_id, sender_id, recipient_id, broadcast_id, content,
      repository_name, branch_name, client_name, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const recipientId of recipientIds) {
    insert.run(
      MessageId.generate().value,
      threadId.value,
      command.senderId.value,
      recipientId.value,
      broadcastId.value,
      command.content.value,
      command.repositoryName.value,
      command.branchName.value,
      command.client.value,
      createdAt,
      expiresAt,
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
    const insert: Statement<
      unknown,
      [
        string,
        string,
        string,
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
    > = database.query(`
      INSERT INTO broadcasts(
        broadcast_id, thread_id, sender_id, content,
        repository_name, branch_name, client_name,
        audience_repository_name, audience_machine_name, idempotency_key,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      broadcastId.value,
      threadId.value,
      command.senderId.value,
      command.content.value,
      command.repositoryName.value,
      command.branchName.value,
      command.client.value,
      audienceRepository,
      audienceMachine,
      idempotencyKey,
      createdAt,
      expiresAt,
    );
    insertRecipients(database, command, broadcastId, threadId, now, createdAt, expiresAt);
    database
      .query<unknown, [string, string]>("UPDATE agents SET last_seen_at = ? WHERE agent_id = ?")
      .run(createdAt, command.senderId.value);
    const stored: Statement<unknown, [string]> = database.query(
      "SELECT * FROM broadcasts WHERE broadcast_id = ?",
    );
    const row: BroadcastRow = BroadcastRowSchema.parse(stored.get(broadcastId.value));
    database.exec("COMMIT");
    return broadcastResult(database, row, false);
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
