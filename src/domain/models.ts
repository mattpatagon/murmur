import type {
  AgentClient,
  AgentId,
  BranchName,
  BroadcastId,
  DisplayName,
  IdempotencyKey,
  Instant,
  JsonObject,
  MessageContent,
  MessageId,
  MachineName,
  RepositoryName,
  Sequence,
  ThreadId,
} from "./value-objects.js";

export type Agent = {
  readonly agentId: AgentId;
  readonly createdAt: Instant;
  readonly displayName: DisplayName;
  readonly lastSeenAt: Instant;
  readonly metadata: JsonObject;
};

export type Message = {
  readonly branchName: BranchName | null;
  readonly broadcastId: BroadcastId | null;
  readonly client: AgentClient | null;
  readonly content: MessageContent;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly messageId: MessageId;
  readonly readAt: Instant | null;
  readonly recipientId: AgentId;
  readonly repositoryName: RepositoryName | null;
  readonly senderId: AgentId;
  readonly sequence: Sequence;
  readonly threadId: ThreadId;
};

export type BroadcastAudience = {
  readonly machineName: MachineName | null;
  readonly repositoryName: RepositoryName | null;
};

export type RegisterAgentCommand = {
  readonly agentId: AgentId;
  readonly displayName: DisplayName;
  readonly metadata: JsonObject;
};

export type SendMessageCommand = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly content: MessageContent;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly recipientId: AgentId;
  readonly repositoryName: RepositoryName | null;
  readonly senderId: AgentId;
  readonly threadId: ThreadId | null;
};

export type SendMessageResult = {
  readonly duplicate: boolean;
  readonly message: Message;
};

export type BroadcastMessageCommand = {
  readonly audience: BroadcastAudience;
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly content: MessageContent;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly repositoryName: RepositoryName | null;
  readonly senderId: AgentId;
  readonly threadId: ThreadId | null;
};

export type BroadcastMessageResult = {
  readonly audience: BroadcastAudience;
  readonly broadcastId: BroadcastId;
  readonly createdAt: Instant;
  readonly duplicate: boolean;
  readonly expiresAt: Instant;
  readonly recipientCount: number;
  readonly threadId: ThreadId;
};

export type GetMessagesQuery = {
  readonly afterSequence: Sequence;
  readonly agentId: AgentId;
  readonly limit: number;
  readonly threadId: ThreadId | null;
  readonly unreadOnly: boolean;
};

export type MarkMessagesReadCommand = {
  readonly agentId: AgentId;
  readonly messageIds: readonly MessageId[];
};

export type MarkMessagesReadResult = {
  readonly readAt: Instant;
  readonly updated: number;
};
