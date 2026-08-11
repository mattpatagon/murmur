import type { AgentGeneration } from "../domain/lifecycle-values.js";
import type {
  Agent,
  BroadcastMessageCommand,
  BroadcastMessageResult,
  CloseAgentCommand,
  CloseAgentResult,
  EndSessionCommand,
  EndSessionResult,
  GetMessagesQuery,
  ListAgentsQuery,
  ListAgentsResult,
  MarkMessagesReadCommand,
  MarkMessagesReadResult,
  Message,
  RegisterAgentCommand,
  RegisterAgentResult,
  SendMessageCommand,
  SendMessageResult,
} from "../domain/models.js";
import type {
  ListNoticesQuery,
  ListNoticesResult,
  PostNoticeCommand,
  PostNoticeResult,
  ResolveNoticeCommand,
  ResolveNoticeResult,
  WithdrawNoticeCommand,
  WithdrawNoticeResult,
} from "../domain/notice-models.js";
import type { AgentId, Instant, Sequence, TenantId } from "../domain/value-objects.js";

export type Awaitable<T> = Promise<T> | T;

export type InboxUpdateHandler = (sequence: Sequence) => Promise<void>;

export interface InboxSubscription {
  close(): Awaitable<void>;
}

export interface MessageStore {
  scope(tenantId: TenantId): MessageStore;
  registerAgent(command: RegisterAgentCommand): Awaitable<RegisterAgentResult>;
  getAgent(agentId: AgentId): Awaitable<Agent | null>;
  listAgents(query: ListAgentsQuery): Awaitable<ListAgentsResult>;
  endSession(command: EndSessionCommand): Awaitable<EndSessionResult>;
  closeAgent(command: CloseAgentCommand): Awaitable<CloseAgentResult>;
  broadcastMessage(command: BroadcastMessageCommand): Awaitable<BroadcastMessageResult>;
  sendMessage(command: SendMessageCommand): Awaitable<SendMessageResult>;
  getMessages(query: GetMessagesQuery): Awaitable<readonly Message[]>;
  markMessagesRead(command: MarkMessagesReadCommand): Awaitable<MarkMessagesReadResult>;
  postNotice(command: PostNoticeCommand): Awaitable<PostNoticeResult>;
  listNotices(query: ListNoticesQuery): Awaitable<ListNoticesResult>;
  resolveNotice(command: ResolveNoticeCommand): Awaitable<ResolveNoticeResult>;
  withdrawNotice(command: WithdrawNoticeCommand): Awaitable<WithdrawNoticeResult>;
  getInboxVersion(agentId: AgentId, generation?: AgentGeneration | null): Awaitable<Sequence>;
  watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): Awaitable<InboxSubscription>;
  pruneExpired(now: Instant): Awaitable<number>;
  close(): Awaitable<void>;
}
