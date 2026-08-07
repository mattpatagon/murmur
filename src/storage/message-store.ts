import type {
  Agent,
  BroadcastMessageCommand,
  BroadcastMessageResult,
  GetMessagesQuery,
  MarkMessagesReadCommand,
  MarkMessagesReadResult,
  Message,
  RegisterAgentCommand,
  SendMessageCommand,
  SendMessageResult,
} from "../domain/models.js";
import type { AgentId, Instant, Sequence } from "../domain/value-objects.js";

export type Awaitable<T> = Promise<T> | T;

export type InboxUpdateHandler = (sequence: Sequence) => Promise<void>;

export interface InboxSubscription {
  close(): Awaitable<void>;
}

export interface MessageStore {
  registerAgent(command: RegisterAgentCommand): Awaitable<Agent>;
  getAgent(agentId: AgentId): Awaitable<Agent | null>;
  listAgents(): Awaitable<readonly Agent[]>;
  broadcastMessage(command: BroadcastMessageCommand): Awaitable<BroadcastMessageResult>;
  sendMessage(command: SendMessageCommand): Awaitable<SendMessageResult>;
  getMessages(query: GetMessagesQuery): Awaitable<readonly Message[]>;
  markMessagesRead(command: MarkMessagesReadCommand): Awaitable<MarkMessagesReadResult>;
  getInboxVersion(agentId: AgentId): Awaitable<Sequence>;
  watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): Awaitable<InboxSubscription>;
  pruneExpired(now: Instant): Awaitable<number>;
  close(): Awaitable<void>;
}
