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

export type AgentRow = {
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

export type MessageRow = {
  readonly branch_name: string | null;
  readonly broadcast_id: string | null;
  readonly client_name: string | null;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
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
  readonly client_name: "claude" | "codex" | "connector";
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

export type SchemaProbeRow = {
  readonly agent_sessions_table: string | null;
  readonly agents_authority_column: boolean;
  readonly agents_generation_column: boolean;
  readonly agents_tenant_column: boolean;
  readonly agents_table: string | null;
  readonly branch_column: boolean;
  readonly broadcast_column: boolean;
  readonly broadcasts_tenant_column: boolean;
  readonly broadcasts_table: string | null;
  readonly broadcasts_authority_column: boolean;
  readonly feedback_submissions_table: string | null;
  readonly client_column: boolean;
  readonly messages_tenant_column: boolean;
  readonly messages_tenant_sequence_column: boolean;
  readonly messages_table: string | null;
  readonly messages_authority_column: boolean;
  readonly messages_kind_column: boolean;
  readonly messages_policy_column: boolean;
  readonly messages_recipient_generation_column: boolean;
  readonly notices_table: string | null;
  readonly repository_column: boolean;
};

export type InboxNotification = {
  readonly agent_id: string;
  readonly sequence: number;
  readonly tenant_id?: string | undefined;
};

export type CountRow = { readonly count: number };
export type InboxVersionRow = { readonly version: number };

const SafeDatabaseIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)), {
    message: "Postgres integer exceeds JavaScript's safe integer range",
  })
  .transform((value: bigint | number | string): number => Number(value));

export const AgentRowSchema: z.ZodType<AgentRow> = z.strictObject({
  agent_id: z.string(),
  authority: SenderAuthoritySchema,
  closed_at: z.string().nullable(),
  close_reason: z.string().nullable(),
  created_at: z.string(),
  display_name: z.string(),
  generation: SafeDatabaseIntegerSchema.pipe(z.number().positive()),
  last_seen_at: z.string(),
  lease_expires_at: z.string().nullable(),
  live_session_count: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
  metadata_json: z.string(),
  state: z.string(),
});

export const MessageRowSchema: z.ZodType<MessageRow> = z.strictObject({
  branch_name: z.string().nullable(),
  broadcast_id: z.string().nullable(),
  client_name: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  message_id: z.string(),
  message_kind: MessageKindSchema,
  orchestrator_policy_id: z.string().uuid().nullable(),
  read_at: z.string().nullable(),
  recipient_id: z.string(),
  recipient_generation: SafeDatabaseIntegerSchema.pipe(z.number().positive()),
  repository_name: z.string().nullable(),
  sender_id: z.string(),
  sender_generation: SafeDatabaseIntegerSchema.pipe(z.number().positive()),
  sender_authority: SenderAuthoritySchema,
  sequence: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
  thread_id: z.string(),
});

export const BroadcastRowSchema: z.ZodType<BroadcastRow> = z.strictObject({
  audience_machine_name: z.string().nullable(),
  audience_repository_name: z.string().nullable(),
  branch_name: z.string(),
  broadcast_id: z.string(),
  client_name: z.enum(["claude", "codex", "connector"]),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  repository_name: z.string(),
  sender_id: z.string(),
  sender_generation: SafeDatabaseIntegerSchema.pipe(z.number().positive()),
  sender_authority: SenderAuthoritySchema,
  thread_id: z.string(),
});

export const AgentIdRowSchema: z.ZodType<{ readonly agent_id: string }> = z.strictObject({
  agent_id: z.string(),
});

export const CountRowSchema: z.ZodType<CountRow> = z.strictObject({
  count: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

export const InboxVersionRowSchema: z.ZodType<InboxVersionRow> = z.strictObject({
  version: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

export const SchemaProbeRowSchema: z.ZodType<SchemaProbeRow> = z.strictObject({
  agent_sessions_table: z.string().nullable(),
  agents_authority_column: z.boolean(),
  agents_generation_column: z.boolean(),
  agents_tenant_column: z.boolean(),
  agents_table: z.string().nullable(),
  branch_column: z.boolean(),
  broadcast_column: z.boolean(),
  broadcasts_tenant_column: z.boolean(),
  broadcasts_table: z.string().nullable(),
  broadcasts_authority_column: z.boolean(),
  feedback_submissions_table: z.string().nullable(),
  client_column: z.boolean(),
  messages_tenant_column: z.boolean(),
  messages_tenant_sequence_column: z.boolean(),
  messages_table: z.string().nullable(),
  messages_authority_column: z.boolean(),
  messages_kind_column: z.boolean(),
  messages_policy_column: z.boolean(),
  messages_recipient_generation_column: z.boolean(),
  notices_table: z.string().nullable(),
  repository_column: z.boolean(),
});

export const InboxNotificationSchema: z.ZodType<InboxNotification> = z.strictObject({
  agent_id: z.string(),
  sequence: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
  tenant_id: z.string().uuid().optional(),
});

export const MessageIdRowSchema: z.ZodType<{ readonly message_id: string }> = z.strictObject({
  message_id: z.string(),
});

export function firstRow<T>(rows: readonly T[], entity: string): T {
  const row: T | undefined = rows[0];
  if (row === undefined) throw new StorageCorruptionError(entity, new Error("Missing row"));
  return row;
}

export function mapAgentRow(input: unknown): Agent {
  try {
    const row: AgentRow = AgentRowSchema.parse(input);
    const parsedMetadata: unknown = JSON.parse(row.metadata_json);
    const metadata: JsonObject = JsonObjectSchema.parse(parsedMetadata);
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
      metadata,
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
