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
import type {
  AgentCloseReason,
  AgentGeneration,
  AgentListState,
  AgentState,
  ExplicitAgentCloseReason,
  SessionEndReason,
  SessionKey,
} from "./lifecycle-values.js";

export type Agent = {
  readonly agentId: AgentId;
  readonly closedAt: Instant | null;
  readonly closeReason: AgentCloseReason | null;
  readonly createdAt: Instant;
  readonly displayName: DisplayName;
  readonly generation: AgentGeneration;
  readonly lastSeenAt: Instant;
  readonly leaseExpiresAt: Instant | null;
  readonly liveSessionCount: number;
  readonly metadata: JsonObject;
  readonly state: AgentState;
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
  readonly recipientGeneration: AgentGeneration;
  readonly repositoryName: RepositoryName | null;
  readonly senderId: AgentId;
  readonly senderGeneration: AgentGeneration;
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
  readonly sessionKey?: SessionKey | undefined;
};

export type RegisterAgentResult = {
  readonly agent: Agent;
  readonly reopened: boolean;
  readonly repositoryDiverged: boolean;
};

export type ListAgentsQuery = {
  readonly state: AgentListState;
};

export type EndSessionCommand = {
  readonly agentId: AgentId;
  readonly endDefaultSession: boolean;
  readonly endReason: SessionEndReason;
  readonly expectedGeneration: AgentGeneration | null;
  readonly sessionKey: SessionKey;
};

export type EndSessionResult = {
  readonly ended: number;
  readonly generation: AgentGeneration | null;
};

export type CloseAgentCommand = {
  readonly agentId: AgentId;
  readonly closeReason: ExplicitAgentCloseReason;
  readonly expectedGeneration: AgentGeneration | null;
};

export type CloseAgentResult = {
  readonly agent: Agent;
  readonly alreadyClosed: boolean;
  readonly endedSessions: number;
  readonly unreadCount: number;
};

export type SendMessageCommand = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly content: MessageContent;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly recipientId: AgentId;
  readonly repositoryName: RepositoryName | null;
  readonly senderId: AgentId;
  readonly sessionKey?: SessionKey | undefined;
  readonly threadId: ThreadId | null;
};

export type SendMessageResult = {
  readonly duplicate: boolean;
  readonly message: Message;
  readonly recipientLastSeenAt: Instant;
  readonly recipientState: AgentState;
};

export type BroadcastMessageCommand = {
  readonly audience: BroadcastAudience;
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly content: MessageContent;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly repositoryName: RepositoryName | null;
  readonly senderId: AgentId;
  readonly sessionKey?: SessionKey | undefined;
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
  readonly generation?: AgentGeneration | null | undefined;
  readonly sessionKey?: SessionKey | null | undefined;
  readonly threadId: ThreadId | null;
  readonly unreadOnly: boolean;
};

export type MarkMessagesReadCommand = {
  readonly agentId: AgentId;
  readonly generation?: AgentGeneration | null | undefined;
  readonly messageIds: readonly MessageId[];
  readonly sessionKey?: SessionKey | null | undefined;
};

export type MarkMessagesReadResult = {
  readonly readAt: Instant;
  readonly updated: number;
};
