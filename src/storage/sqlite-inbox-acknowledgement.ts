import type { Changes, Database, Statement } from "bun:sqlite";

import { StorageCorruptionError } from "../domain/errors.js";
import type { Message } from "../domain/models.js";
import type { AgentId, Instant } from "../domain/value-objects.js";

export function acknowledgeSqliteMessages(
  database: Database,
  messages: readonly Message[],
  agentId: AgentId,
  generation: number,
  now: Instant,
): readonly Message[] {
  const messageIds: string[] = messages
    .filter((message: Message): boolean => message.readAt === null)
    .map((message: Message): string => message.messageId.value);
  if (messageIds.length === 0) return messages;
  const statement: Statement<unknown, [string, string, number, string, string]> = database.query(`
    UPDATE messages
    SET read_at = COALESCE(read_at, ?)
    WHERE recipient_id = ?
      AND recipient_generation = ?
      AND message_id IN (SELECT value FROM json_each(?))
      AND expires_at > ?
  `);
  const changes: Changes = statement.run(
    now.toISOString(),
    agentId.value,
    generation,
    JSON.stringify(messageIds),
    now.toISOString(),
  );
  if (changes.changes !== messageIds.length) {
    throw new StorageCorruptionError(
      "automatic message acknowledgement",
      new Error("Acknowledged message count does not match the returned inbox page"),
    );
  }
  return messages.map(
    (message: Message): Message =>
      message.readAt === null ? { ...message, readAt: now } : message,
  );
}
