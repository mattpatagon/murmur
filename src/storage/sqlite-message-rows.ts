import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import {
  AgentCloseReasonSchema,
  AgentGeneration,
  AgentStateSchema,
} from "../domain/lifecycle-values.js";
import type { Agent, Message } from "../domain/models.js";
import {
  MessageKindSchema,
  OrchestratorPolicyId,
  SenderAuthoritySchema,
} from "../domain/orchestration.js";
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
  readonly authority: "orchestrator" | "peer";
  readonly closed_at: string | null;
  readonly close_reason: string | null;
  readonly created_at: string;
  readonly display_name: string;
  readonly generation: number;
  readonly last_seen_at: string;
  readonly lease_expires_at: string | null;
  readonly live_session_count: number;
  readonly metadata_json: string;
  readonly state: string;
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
  readonly message_kind: "message" | "orchestration_request";
  readonly orchestrator_policy_id: string | null;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly recipient_generation: number;
  readonly repository_name: string | null;
  readonly sender_id: string;
  readonly sender_generation: number;
  readonly sender_authority: "orchestrator" | "peer";
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
  readonly sender_generation: number;
  readonly sender_authority: "orchestrator" | "peer";
  readonly thread_id: string;
};

export type UserVersionRow = {
  readonly user_version: number;
};

export type InboxVersionRow = {
  readonly version: number;
};

const SafeSqlIntegerSchema: z.ZodType<number> = z
  .union([z.number().int(), z.bigint()])
  .refine((value: number | bigint): boolean => Number.isSafeInteger(Number(value)), {
    message: "SQLite integer exceeds JavaScript's safe integer range",
  })
  .transform((value: number | bigint): number => Number(value));

const AgentRowSchema: z.ZodType<AgentRow> = z.strictObject({
  agent_id: z.string(),
  authority: SenderAuthoritySchema,
  closed_at: z.string().nullable(),
  close_reason: z.string().nullable(),
  created_at: z.string(),
  display_name: z.string(),
  generation: SafeSqlIntegerSchema.pipe(z.number().positive()),
  last_seen_at: z.string(),
  lease_expires_at: z.string().nullable(),
  live_session_count: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
  metadata_json: z.string(),
  state: z.string(),
});

const MessageRowSchema: z.ZodType<MessageRow> = z.strictObject({
  branch_name: z.string().nullable(),
  broadcast_id: z.string().nullable(),
  client_name: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  message_id: z.string(),
  message_kind: MessageKindSchema,
  orchestrator_policy_id: z.string().uuid().nullable(),
  read_at: z.string().nullable(),
  recipient_id: z.string(),
  recipient_generation: SafeSqlIntegerSchema.pipe(z.number().positive()),
  repository_name: z.string().nullable(),
  sender_id: z.string(),
  sender_generation: SafeSqlIntegerSchema.pipe(z.number().positive()),
  sender_authority: SenderAuthoritySchema,
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
  sender_generation: SafeSqlIntegerSchema.pipe(z.number().positive()),
  sender_authority: SenderAuthoritySchema,
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
      authority: row.authority,
      closedAt: row.closed_at === null ? null : Instant.parse(row.closed_at),
      closeReason:
        row.close_reason === null ? null : AgentCloseReasonSchema.parse(row.close_reason),
      createdAt: Instant.parse(row.created_at),
      displayName: DisplayName.parse(row.display_name),
      generation: AgentGeneration.parse(row.generation),
      lastSeenAt: Instant.parse(row.last_seen_at),
      leaseExpiresAt: row.lease_expires_at === null ? null : Instant.parse(row.lease_expires_at),
      liveSessionCount: row.live_session_count,
      metadata: parseJsonObject(row.metadata_json),
      state: AgentStateSchema.parse(row.state),
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
      messageKind: row.message_kind,
      orchestratorPolicyId:
        row.orchestrator_policy_id === null
          ? null
          : OrchestratorPolicyId.parse(row.orchestrator_policy_id),
      readAt,
      recipientId: AgentId.parse(row.recipient_id),
      recipientGeneration: AgentGeneration.parse(row.recipient_generation),
      repositoryName:
        row.repository_name === null ? null : RepositoryName.parse(row.repository_name),
      senderId: AgentId.parse(row.sender_id),
      senderGeneration: AgentGeneration.parse(row.sender_generation),
      senderAuthority: row.sender_authority,
      sequence: Sequence.parse(row.sequence),
      threadId: ThreadId.parse(row.thread_id),
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("message", error);
  }
}
