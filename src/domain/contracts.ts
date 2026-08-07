import { z } from "zod";

import type { Agent, Message } from "./models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  DisplayName,
  IdempotencyKey,
  JsonObjectSchema,
  MessageContent,
  MessageId,
  RepositoryName,
  Sequence,
  ThreadId,
  type JsonObject,
} from "./value-objects.js";

export const RETENTION_DAYS: number = 30;

const AgentIdTextSchema: z.ZodString = z.string().min(1).max(200);
const DisplayNameTextSchema: z.ZodString = z.string().min(1).max(200);
const MessageIdTextSchema: z.ZodString = z.string().uuid();
const ThreadIdTextSchema: z.ZodString = z.string().min(1).max(200);
const MessageContentTextSchema: z.ZodString = z.string().min(1).max(100_000);
const RepositoryNameTextSchema: z.ZodString = z
  .string()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u);
const BranchNameTextSchema: z.ZodString = z.string().trim().min(1).max(500);
const AgentClientTextSchema: z.ZodEnum<{
  claude: "claude";
  codex: "codex";
}> = z.enum(["claude", "codex"]);
const InstantTextSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const SequenceNumberSchema: z.ZodNumber = z.number().int().nonnegative().safe();

export type AgentDto = {
  readonly agent_id: string;
  readonly created_at: string;
  readonly display_name: string;
  readonly last_seen_at: string;
  readonly metadata: JsonObject;
};

export type MessageDto = {
  readonly content: string;
  readonly context: MessageContextDto;
  readonly created_at: string;
  readonly expires_at: string;
  readonly message_id: string;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly sequence: number;
  readonly thread_id: string;
};

export type MessageContextDto = {
  readonly branch?: string | undefined;
  readonly client?: "claude" | "codex" | undefined;
  readonly repository?: string | undefined;
};

export const MessageContextDtoSchema: z.ZodType<MessageContextDto> = z.strictObject({
  branch: BranchNameTextSchema.optional(),
  client: AgentClientTextSchema.optional(),
  repository: RepositoryNameTextSchema.optional(),
});

export const AgentDtoSchema: z.ZodType<AgentDto> = z.strictObject({
  agent_id: AgentIdTextSchema,
  created_at: InstantTextSchema,
  display_name: DisplayNameTextSchema,
  last_seen_at: InstantTextSchema,
  metadata: JsonObjectSchema,
});

export const MessageDtoSchema: z.ZodType<MessageDto> = z.strictObject({
  content: MessageContentTextSchema,
  context: MessageContextDtoSchema,
  created_at: InstantTextSchema,
  expires_at: InstantTextSchema,
  message_id: MessageIdTextSchema,
  read_at: InstantTextSchema.nullable(),
  recipient_id: AgentIdTextSchema,
  sender_id: AgentIdTextSchema,
  sequence: SequenceNumberSchema,
  thread_id: ThreadIdTextSchema,
});

export function toAgentDto(agent: Agent): AgentDto {
  return {
    agent_id: agent.agentId.value,
    created_at: agent.createdAt.toISOString(),
    display_name: agent.displayName.value,
    last_seen_at: agent.lastSeenAt.toISOString(),
    metadata: agent.metadata,
  };
}

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
    read_at: readAt,
    recipient_id: message.recipientId.value,
    sender_id: message.senderId.value,
    sequence: message.sequence.value,
    thread_id: message.threadId.value,
  };
}

export type RegisterAgentInput = {
  readonly agent_id: string;
  readonly display_name?: string | undefined;
  readonly metadata?: JsonObject | undefined;
};

export type ListAgentsInput = Record<string, never>;

export type SendMessageInput = {
  readonly content: string;
  readonly context?: MessageContextDto | undefined;
  readonly idempotency_key?: string | undefined;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly thread_id?: string | undefined;
};

export type GetMessagesInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly limit: number;
  readonly thread_id?: string | undefined;
  readonly unread_only: boolean;
};

export type WaitForMessagesInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly timeout_seconds: number;
};

export type MarkMessagesReadInput = {
  readonly agent_id: string;
  readonly message_ids: string[];
};

export const RegisterAgentInputSchema: z.ZodType<RegisterAgentInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  display_name: DisplayNameTextSchema.optional(),
  metadata: JsonObjectSchema.optional(),
});

export const ListAgentsInputSchema: z.ZodType<ListAgentsInput> = z.strictObject({});

export const SendMessageInputSchema: z.ZodType<SendMessageInput> = z.strictObject({
  content: MessageContentTextSchema,
  context: MessageContextDtoSchema.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  recipient_id: AgentIdTextSchema,
  sender_id: AgentIdTextSchema,
  thread_id: ThreadIdTextSchema.optional(),
});

export const GetMessagesInputSchema: z.ZodType<GetMessagesInput> = z.strictObject({
  after_sequence: SequenceNumberSchema.default(0),
  agent_id: AgentIdTextSchema,
  limit: z.number().int().min(1).max(500).default(100),
  thread_id: ThreadIdTextSchema.optional(),
  unread_only: z.boolean().default(false),
});

export const WaitForMessagesInputSchema: z.ZodType<WaitForMessagesInput> = z.strictObject({
  after_sequence: SequenceNumberSchema.default(0),
  agent_id: AgentIdTextSchema,
  timeout_seconds: z.number().int().min(1).max(25).default(20),
});

export const MarkMessagesReadInputSchema: z.ZodType<MarkMessagesReadInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  message_ids: z.array(MessageIdTextSchema).min(1).max(500),
});

export type RegisterAgentOutput = Record<string, unknown> & {
  readonly agent: AgentDto;
  readonly inbox_uri: string;
  readonly retention_days: number;
};

export type ListAgentsOutput = Record<string, unknown> & {
  readonly agents: AgentDto[];
};

export type SendMessageOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly message: MessageDto;
  readonly retention_days: number;
  readonly status: string;
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

export const RegisterAgentOutputSchema: z.ZodType<RegisterAgentOutput> = z.strictObject({
  agent: AgentDtoSchema,
  inbox_uri: z.string().url(),
  retention_days: z.number().int().positive(),
});

export const ListAgentsOutputSchema: z.ZodType<ListAgentsOutput> = z.strictObject({
  agents: z.array(AgentDtoSchema),
});

export const SendMessageOutputSchema: z.ZodType<SendMessageOutput> = z.strictObject({
  duplicate: z.boolean(),
  message: MessageDtoSchema,
  retention_days: z.number().int().positive(),
  status: z.string(),
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

export function registerAgentCommand(input: RegisterAgentInput): {
  readonly agentId: AgentId;
  readonly displayName: DisplayName;
  readonly metadata: JsonObject;
} {
  const agentId: AgentId = AgentId.parse(input.agent_id);
  const displayNameText: string =
    input.display_name === undefined ? input.agent_id : input.display_name;
  const metadata: JsonObject = input.metadata === undefined ? {} : input.metadata;
  return { agentId, displayName: DisplayName.parse(displayNameText), metadata };
}

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
