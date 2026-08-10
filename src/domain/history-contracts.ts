import { z } from "zod";

import { AgentGeneration } from "./lifecycle-values.js";
import type { GetMessagesQuery, Message } from "./models.js";
import { AgentId, Sequence, ThreadId } from "./value-objects.js";
import { MessageContextDtoSchema, type MessageContextDto } from "./contracts.js";

const AgentIdTextSchema: z.ZodString = z.string().min(1).max(200);
const InstantTextSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const SequenceNumberSchema: z.ZodNumber = z.number().int().nonnegative().safe();
const GenerationNumberSchema: z.ZodNumber = z.number().int().positive().safe();

export type GetMessageHistoryInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly generation: number;
  readonly limit: number;
  readonly thread_id?: string | undefined;
  readonly unread_only: boolean;
};

export const GetMessageHistoryInputSchema: z.ZodType<GetMessageHistoryInput> = z.strictObject({
  after_sequence: SequenceNumberSchema.default(0),
  agent_id: AgentIdTextSchema,
  generation: GenerationNumberSchema,
  limit: z.number().int().min(1).max(500).default(100),
  thread_id: z.string().min(1).max(200).optional(),
  unread_only: z.boolean().default(false),
});

export function historyQuery(input: GetMessageHistoryInput): GetMessagesQuery {
  return {
    afterSequence: Sequence.parse(input.after_sequence),
    agentId: AgentId.parse(input.agent_id),
    generation: AgentGeneration.parse(input.generation),
    limit: input.limit,
    sessionKey: null,
    threadId: input.thread_id === undefined ? null : ThreadId.parse(input.thread_id),
    unreadOnly: input.unread_only,
  };
}

export type HistoryMessageDto = {
  readonly content: string;
  readonly context: MessageContextDto;
  readonly created_at: string;
  readonly expires_at: string;
  readonly message_id: string;
  readonly read_at: string | null;
  readonly recipient_generation: number;
  readonly recipient_id: string;
  readonly sender_generation: number;
  readonly sender_id: string;
  readonly sequence: number;
  readonly thread_id: string;
};

export const HistoryMessageDtoSchema: z.ZodType<HistoryMessageDto> = z.strictObject({
  content: z.string().min(1).max(100_000),
  context: MessageContextDtoSchema,
  created_at: InstantTextSchema,
  expires_at: InstantTextSchema,
  message_id: z.string().uuid(),
  read_at: InstantTextSchema.nullable(),
  recipient_generation: GenerationNumberSchema,
  recipient_id: AgentIdTextSchema,
  sender_generation: GenerationNumberSchema,
  sender_id: AgentIdTextSchema,
  sequence: SequenceNumberSchema,
  thread_id: z.string().min(1).max(200),
});

export function toHistoryMessageDto(message: Message): HistoryMessageDto {
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
    read_at: message.readAt === null ? null : message.readAt.toISOString(),
    recipient_generation: message.recipientGeneration.value,
    recipient_id: message.recipientId.value,
    sender_generation: message.senderGeneration.value,
    sender_id: message.senderId.value,
    sequence: message.sequence.value,
    thread_id: message.threadId.value,
  };
}

export type MessageHistoryOutput = Record<string, unknown> & {
  readonly agent_id: string;
  readonly generation: number;
  readonly inbox_version: number;
  readonly messages: HistoryMessageDto[];
};

export const MessageHistoryOutputSchema: z.ZodType<MessageHistoryOutput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  generation: GenerationNumberSchema,
  inbox_version: SequenceNumberSchema,
  messages: z.array(HistoryMessageDtoSchema),
});
