import { z } from "zod";

import { type AgentClientName, AgentClientNameSchema } from "./client-provenance.js";
import { AgentGeneration, SessionKey, SessionKeyInputSchema } from "./lifecycle-values.js";
import type { Message } from "./models.js";
import { MessageKindSchema, SenderAuthoritySchema } from "./orchestration.js";
import {
  AgentClient,
  BranchName,
  IdempotencyKey,
  MachineName,
  MessageContent,
  MessageId,
  RepositoryName,
  Sequence,
  ThreadId,
} from "./value-objects.js";

export type {
  AgentDto,
  CloseAgentInput,
  CloseAgentOutput,
  EndSessionInput,
  EndSessionOutput,
  GetAgentInput,
  GetAgentOutput,
  ListAgentsInput,
  ListAgentsOutput,
  RegisterAgentInput,
  RegisterAgentOutput,
} from "./agent-contracts.js";
export {
  AgentDtoSchema,
  CloseAgentInputSchema,
  CloseAgentOutputSchema,
  closeAgentCommand,
  EndSessionInputSchema,
  EndSessionOutputSchema,
  encodeAgentCursor,
  endSessionCommand,
  GetAgentInputSchema,
  GetAgentOutputSchema,
  ListAgentsInputSchema,
  ListAgentsOutputSchema,
  listAgentsQuery,
  RegisterAgentInputSchema,
  RegisterAgentOutputSchema,
  registerAgentCommand,
  toAgentDto,
  toListAgentsOutput,
} from "./agent-contracts.js";

export const RETENTION_DAYS: number = 30;

const AgentIdTextSchema: z.ZodString = z.string().min(1).max(200);
const MessageIdTextSchema: z.ZodString = z.string().uuid();
const BroadcastIdTextSchema: z.ZodString = z.string().uuid();
const ThreadIdTextSchema: z.ZodString = z.string().min(1).max(200);
const MessageContentTextSchema: z.ZodString = z.string().min(1).max(100_000);
const RepositoryNameTextSchema: z.ZodString = z
  .string()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u);
const BranchNameTextSchema: z.ZodString = z.string().trim().min(1).max(500);
const MachineNameTextSchema: z.ZodString = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const InstantTextSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const SequenceNumberSchema: z.ZodNumber = z.number().int().nonnegative().safe();

export type MessageDto = {
  readonly content: string;
  readonly context: MessageContextDto;
  readonly created_at: string;
  readonly expires_at: string;
  readonly message_id: string;
  readonly message_kind: "message" | "orchestration_request";
  readonly orchestrator_policy_id: string | null;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly sender_authority: "orchestrator" | "peer";
  readonly sequence: number;
  readonly thread_id: string;
};

export type BroadcastAudienceDto = {
  readonly machine?: string | undefined;
  readonly repository?: string | undefined;
};

export type MessageContextDto = {
  readonly branch?: string | undefined;
  readonly client?: AgentClientName | undefined;
  readonly repository?: string | undefined;
};

export const MessageContextDtoSchema: z.ZodType<MessageContextDto> = z.strictObject({
  branch: BranchNameTextSchema.optional(),
  client: AgentClientNameSchema.optional(),
  repository: RepositoryNameTextSchema.optional(),
});

export const MessageDtoSchema: z.ZodType<MessageDto> = z.strictObject({
  content: MessageContentTextSchema,
  context: MessageContextDtoSchema,
  created_at: InstantTextSchema,
  expires_at: InstantTextSchema,
  message_id: MessageIdTextSchema,
  message_kind: MessageKindSchema,
  orchestrator_policy_id: z.string().uuid().nullable(),
  read_at: InstantTextSchema.nullable(),
  recipient_id: AgentIdTextSchema,
  sender_id: AgentIdTextSchema,
  sender_authority: SenderAuthoritySchema,
  sequence: SequenceNumberSchema,
  thread_id: ThreadIdTextSchema,
});

export function toMessageDto(message: Message): MessageDto {
  const readAt: string | null = message.readAt === null ? null : message.readAt.toISOString();
  const context: MessageContextDto = {
    ...(message.branchName === null ? {} : { branch: message.branchName.value }),
    ...(message.client === null ? {} : { client: message.client.value }),
    ...(message.repositoryName === null ? {} : { repository: message.repositoryName.value }),
  };
  return {
    content: message.content.value,
    context,
    created_at: message.createdAt.toISOString(),
    expires_at: message.expiresAt.toISOString(),
    message_id: message.messageId.value,
    message_kind: message.messageKind,
    orchestrator_policy_id:
      message.orchestratorPolicyId === null ? null : message.orchestratorPolicyId.value,
    read_at: readAt,
    recipient_id: message.recipientId.value,
    sender_id: message.senderId.value,
    sender_authority: message.senderAuthority,
    sequence: message.sequence.value,
    thread_id: message.threadId.value,
  };
}

export type SendMessageInput = {
  readonly content: string;
  readonly context?: MessageContextDto | undefined;
  readonly idempotency_key?: string | undefined;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly session_key?: string | undefined;
  readonly thread_id?: string | undefined;
};

export type BroadcastMessageInput = {
  readonly audience?: BroadcastAudienceDto | undefined;
  readonly content: string;
  readonly context?: MessageContextDto | undefined;
  readonly idempotency_key?: string | undefined;
  readonly sender_id: string;
  readonly session_key?: string | undefined;
  readonly thread_id?: string | undefined;
};

export type GetMessagesInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly limit: number;
  readonly session_key?: string | undefined;
  readonly thread_id?: string | undefined;
  readonly unread_only: boolean;
};

export type WaitForMessagesInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly session_key?: string | undefined;
  readonly timeout_seconds: number;
};

export type MarkMessagesReadInput = {
  readonly agent_id: string;
  readonly message_ids: string[];
  readonly session_key?: string | undefined;
};

export const SendMessageInputSchema: z.ZodType<SendMessageInput> = z.strictObject({
  content: MessageContentTextSchema,
  context: MessageContextDtoSchema.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  recipient_id: AgentIdTextSchema,
  sender_id: AgentIdTextSchema,
  session_key: SessionKeyInputSchema.optional(),
  thread_id: ThreadIdTextSchema.optional(),
});

export const BroadcastAudienceDtoSchema: z.ZodType<BroadcastAudienceDto> = z.strictObject({
  machine: MachineNameTextSchema.optional(),
  repository: RepositoryNameTextSchema.optional(),
});

export const BroadcastMessageInputSchema: z.ZodType<BroadcastMessageInput> = z.strictObject({
  audience: BroadcastAudienceDtoSchema.default({}),
  content: MessageContentTextSchema,
  context: MessageContextDtoSchema.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  sender_id: AgentIdTextSchema,
  session_key: SessionKeyInputSchema.optional(),
  thread_id: ThreadIdTextSchema.optional(),
});

export const GetMessagesInputSchema: z.ZodType<GetMessagesInput> = z.strictObject({
  after_sequence: SequenceNumberSchema.default(0),
  agent_id: AgentIdTextSchema,
  limit: z.number().int().min(1).max(500).default(100),
  session_key: SessionKeyInputSchema.optional(),
  thread_id: ThreadIdTextSchema.optional(),
  unread_only: z.boolean().default(false),
});

export const WaitForMessagesInputSchema: z.ZodType<WaitForMessagesInput> = z.strictObject({
  after_sequence: SequenceNumberSchema.default(0),
  agent_id: AgentIdTextSchema,
  session_key: SessionKeyInputSchema.optional(),
  timeout_seconds: z.number().int().min(1).max(25).default(20),
});

export const MarkMessagesReadInputSchema: z.ZodType<MarkMessagesReadInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  message_ids: z.array(MessageIdTextSchema).min(1).max(500),
  session_key: SessionKeyInputSchema.optional(),
});

export type SendMessageOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly message: MessageDto;
  readonly retention_days: number;
  readonly recipient_last_seen_at: string;
  readonly recipient_state: "active" | "closed" | "inactive";
  readonly status: string;
};

export type BroadcastMessageOutput = Record<string, unknown> & {
  readonly audience: BroadcastAudienceDto;
  readonly broadcast_id: string;
  readonly created_at: string;
  readonly duplicate: boolean;
  readonly expires_at: string;
  readonly recipient_count: number;
  readonly retention_days: number;
  readonly status: string;
  readonly thread_id: string;
};

export type InboxOutput = Record<string, unknown> & {
  readonly agent_id: string;
  readonly inbox_version: number;
  readonly messages: MessageDto[];
};

export type WaitForMessagesOutput = Record<string, unknown> & {
  readonly agent_id: string;
  readonly messages: MessageDto[];
  readonly timed_out: boolean;
};

export type MarkMessagesReadOutput = Record<string, unknown> & {
  readonly read_at: string;
  readonly updated: number;
};

export const SendMessageOutputSchema: z.ZodType<SendMessageOutput> = z.strictObject({
  duplicate: z.boolean(),
  message: MessageDtoSchema,
  retention_days: z.number().int().positive(),
  recipient_last_seen_at: InstantTextSchema,
  recipient_state: z.enum(["active", "inactive", "closed"]),
  status: z.string(),
});

export const BroadcastMessageOutputSchema: z.ZodType<BroadcastMessageOutput> = z.strictObject({
  audience: BroadcastAudienceDtoSchema,
  broadcast_id: BroadcastIdTextSchema,
  created_at: InstantTextSchema,
  duplicate: z.boolean(),
  expires_at: InstantTextSchema,
  recipient_count: z.number().int().nonnegative(),
  retention_days: z.number().int().positive(),
  status: z.string(),
  thread_id: ThreadIdTextSchema,
});

export const InboxOutputSchema: z.ZodType<InboxOutput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  inbox_version: SequenceNumberSchema,
  messages: z.array(MessageDtoSchema),
});

export const WaitForMessagesOutputSchema: z.ZodType<WaitForMessagesOutput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  messages: z.array(MessageDtoSchema),
  timed_out: z.boolean(),
});

export const MarkMessagesReadOutputSchema: z.ZodType<MarkMessagesReadOutput> = z.strictObject({
  read_at: InstantTextSchema,
  updated: z.number().int().nonnegative(),
});

export function nullableThreadId(input: string | undefined): ThreadId | null {
  return input === undefined ? null : ThreadId.parse(input);
}

export function nullableIdempotencyKey(input: string | undefined): IdempotencyKey | null {
  return input === undefined ? null : IdempotencyKey.parse(input);
}

export function parseMessageIds(inputs: readonly string[]): MessageId[] {
  return inputs.map((input: string): MessageId => MessageId.parse(input));
}

export function parseContent(input: string): MessageContent {
  return MessageContent.parse(input);
}

export function broadcastAudienceFromInput(input: BroadcastAudienceDto | undefined): {
  readonly machineName: MachineName | null;
  readonly repositoryName: RepositoryName | null;
} {
  return {
    machineName:
      input === undefined || input.machine === undefined ? null : MachineName.parse(input.machine),
    repositoryName:
      input === undefined || input.repository === undefined
        ? null
        : RepositoryName.parse(input.repository),
  };
}

export function repositoryNameFromInput(
  input: MessageContextDto | undefined,
  fallback: RepositoryName | null,
): RepositoryName | null {
  if (input === undefined || input.repository === undefined) return fallback;
  return RepositoryName.parse(input.repository);
}

export function branchNameFromInput(
  input: MessageContextDto | undefined,
  fallback: BranchName | null,
): BranchName | null {
  if (input === undefined || input.branch === undefined) return fallback;
  return BranchName.parse(input.branch);
}

export function agentClientFromInput(
  input: MessageContextDto | undefined,
  fallback: AgentClient | null,
): AgentClient | null {
  if (input === undefined || input.client === undefined) return fallback;
  return AgentClient.parse(input.client);
}

export function parseSequence(input: number): Sequence {
  return Sequence.parse(input);
}

export function nullableSessionKey(input: string | undefined): SessionKey | null {
  return input === undefined ? null : SessionKey.parse(input);
}

export function nullableGeneration(input: number | undefined): AgentGeneration | null {
  return input === undefined ? null : AgentGeneration.parse(input);
}
