import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import type { Agent, Message } from "../domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  BroadcastId,
  DisplayName,
  Instant,
  type JsonObject,
  JsonObjectSchema,
  MessageContent,
  MessageId,
  RepositoryName,
  Sequence,
  ThreadId,
} from "../domain/value-objects.js";

type AgentRow = {
  readonly agent_id: string;
  readonly created_at: string;
  readonly display_name: string;
  readonly last_seen_at: string;
  readonly metadata_json: string;
};

type MessageRow = {
  readonly branch_name: string | null;
  readonly broadcast_id: string | null;
  readonly client_name: string | null;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_key: string | null;
  readonly message_id: string;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly repository_name: string | null;
  readonly sender_id: string;
  readonly sequence: number;
  readonly thread_id: string;
};

export type BroadcastRow = {
  readonly audience_machine_name: string | null;
  readonly audience_repository_name: string | null;
  readonly branch_name: string;
  readonly broadcast_id: string;
  readonly client_name: "claude" | "codex";
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_key: string | null;
  readonly repository_name: string;
  readonly sender_id: string;
  readonly thread_id: string;
};

export type UserVersionRow = {
  readonly user_version: number;
};

export type InboxVersionRow = {
  readonly version: number;
};

const AgentRowSchema: z.ZodType<AgentRow> = z.strictObject({
  agent_id: z.string(),
  created_at: z.string(),
  display_name: z.string(),
  last_seen_at: z.string(),
  metadata_json: z.string(),
});

const SafeSqlIntegerSchema: z.ZodType<number> = z
  .union([z.number().int(), z.bigint()])
  .refine((value: number | bigint): boolean => Number.isSafeInteger(Number(value)), {
    message: "SQLite integer exceeds JavaScript's safe integer range",
  })
  .transform((value: number | bigint): number => Number(value));

const MessageRowSchema: z.ZodType<MessageRow> = z.strictObject({
  branch_name: z.string().nullable(),
  broadcast_id: z.string().nullable(),
  client_name: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  message_id: z.string(),
  read_at: z.string().nullable(),
  recipient_id: z.string(),
  repository_name: z.string().nullable(),
  sender_id: z.string(),
  sequence: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
  thread_id: z.string(),
});

export const BroadcastRowSchema: z.ZodType<BroadcastRow> = z.strictObject({
  audience_machine_name: z.string().nullable(),
  audience_repository_name: z.string().nullable(),
  branch_name: z.string(),
  broadcast_id: z.string(),
  client_name: z.enum(["claude", "codex"]),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  repository_name: z.string(),
  sender_id: z.string(),
  thread_id: z.string(),
});

export const AgentIdRowSchema: z.ZodType<{ readonly agent_id: string }> = z.strictObject({
  agent_id: z.string(),
});

export const CountRowSchema: z.ZodType<{ readonly count: number }> = z.strictObject({
  count: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
});

export const UserVersionRowSchema: z.ZodType<UserVersionRow> = z.strictObject({
  user_version: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
});

export const InboxVersionRowSchema: z.ZodType<InboxVersionRow> = z.strictObject({
  version: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
});

function parseJsonObject(input: string): JsonObject {
  const parsed: unknown = JSON.parse(input);
  return JsonObjectSchema.parse(parsed);
}

export function mapAgentRow(input: unknown): Agent {
  try {
    const row: AgentRow = AgentRowSchema.parse(input);
    return {
      agentId: AgentId.parse(row.agent_id),
      createdAt: Instant.parse(row.created_at),
      displayName: DisplayName.parse(row.display_name),
      lastSeenAt: Instant.parse(row.last_seen_at),
      metadata: parseJsonObject(row.metadata_json),
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("agent", error);
  }
}

export function mapMessageRow(input: unknown): Message {
  try {
    const row: MessageRow = MessageRowSchema.parse(input);
    const readAt: Instant | null = row.read_at === null ? null : Instant.parse(row.read_at);
    return {
      branchName: row.branch_name === null ? null : BranchName.parse(row.branch_name),
      broadcastId: row.broadcast_id === null ? null : BroadcastId.parse(row.broadcast_id),
      client: row.client_name === null ? null : AgentClient.parse(row.client_name),
      content: MessageContent.parse(row.content),
      createdAt: Instant.parse(row.created_at),
      expiresAt: Instant.parse(row.expires_at),
      messageId: MessageId.parse(row.message_id),
      readAt,
      recipientId: AgentId.parse(row.recipient_id),
      repositoryName:
        row.repository_name === null ? null : RepositoryName.parse(row.repository_name),
      senderId: AgentId.parse(row.sender_id),
      sequence: Sequence.parse(row.sequence),
      threadId: ThreadId.parse(row.thread_id),
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("message", error);
  }
}

export function minutesBefore(instant: Instant, minutes: number): Instant {
  return Instant.fromDate(new Date(instant.toEpochMilliseconds() - minutes * 60 * 1000));
}
