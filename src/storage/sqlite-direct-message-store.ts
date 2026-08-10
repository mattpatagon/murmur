import type { Changes, Database, Statement } from "bun:sqlite";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import {
  AgentClosedError,
  IdempotencyConflictError,
  IdempotencyWinnerMissingError,
} from "../domain/errors.js";
import type { Agent, Message, SendMessageCommand, SendMessageResult } from "../domain/models.js";
import { type MessageProvenance, ordinaryMessageProvenance } from "../domain/orchestration.js";
import { type Instant, MessageId, ThreadId } from "../domain/value-objects.js";
import { renewSqliteSession, sqliteAgent } from "./sqlite-agent-lifecycle-store.js";
import { mapMessageRow } from "./sqlite-message-rows.js";

function existingMessageResult(
  database: Database,
  command: SendMessageCommand,
  recipient: Agent,
  provenance: MessageProvenance,
): SendMessageResult | null {
  if (command.idempotencyKey === null) return null;
  const rawRow: unknown = database
    .query<unknown, [string, string]>(`
      SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?
    `)
    .get(command.senderId.value, command.idempotencyKey.value);
  if (rawRow === null) return null;
  const existing: Message = mapMessageRow(rawRow);
  const sameThread: boolean =
    command.threadId === null || existing.threadId.value === command.threadId.value;
  const sameRequest: boolean =
    existing.recipientId.equals(command.recipientId) &&
    existing.content.value === command.content.value &&
    existing.senderAuthority === provenance.senderAuthority &&
    existing.messageKind === provenance.messageKind &&
    ((existing.orchestratorPolicyId === null && provenance.orchestratorPolicyId === null) ||
      (existing.orchestratorPolicyId !== null &&
        provenance.orchestratorPolicyId !== null &&
        existing.orchestratorPolicyId.equals(provenance.orchestratorPolicyId))) &&
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
  return {
    duplicate: true,
    message: existing,
    recipientLastSeenAt: recipient.lastSeenAt,
    recipientState: recipient.state,
  };
}

export function sendSqliteMessage(
  database: Database,
  command: SendMessageCommand,
  now: Instant,
): SendMessageResult {
  const provenance: MessageProvenance =
    command.provenance === undefined ? ordinaryMessageProvenance() : command.provenance;
  database.exec("BEGIN IMMEDIATE");
  try {
    const recipient: Agent = sqliteAgent(database, command.recipientId, now);
    const existing: SendMessageResult | null = existingMessageResult(
      database,
      command,
      recipient,
      provenance,
    );
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
    if (recipient.state === "closed") throw new AgentClosedError(recipient.agentId.value);
    const messageId: MessageId = MessageId.generate();
    const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
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
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    > = database.query(`
      INSERT INTO messages(
        message_id, thread_id, sender_id, recipient_id,
        sender_generation, recipient_generation, content,
        sender_authority, message_kind, orchestrator_policy_id,
        repository_name, branch_name, client_name, idempotency_key, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sender_id, idempotency_key) DO NOTHING
    `);
    const inserted: Changes = insert.run(
      messageId.value,
      threadId.value,
      command.senderId.value,
      command.recipientId.value,
      sender.generation.value,
      recipient.generation.value,
      command.content.value,
      provenance.senderAuthority,
      provenance.messageKind,
      provenance.orchestratorPolicyId === null ? null : provenance.orchestratorPolicyId.value,
      command.repositoryName === null ? null : command.repositoryName.value,
      command.branchName === null ? null : command.branchName.value,
      command.client === null ? null : command.client.value,
      command.idempotencyKey === null ? null : command.idempotencyKey.value,
      now.toISOString(),
      now.addDays(RETENTION_DAYS).toISOString(),
    );
    if (inserted.changes === 0) {
      const winner: SendMessageResult | null = existingMessageResult(
        database,
        command,
        recipient,
        provenance,
      );
      if (winner === null) throw new IdempotencyWinnerMissingError();
      database.exec("COMMIT");
      return winner;
    }
    const storedRow: unknown = database
      .query<unknown, [string]>("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId.value);
    if (storedRow === null) throw new Error("Inserted message could not be read back");
    database.exec("COMMIT");
    return {
      duplicate: false,
      message: mapMessageRow(storedRow),
      recipientLastSeenAt: recipient.lastSeenAt,
      recipientState: recipient.state,
    };
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
