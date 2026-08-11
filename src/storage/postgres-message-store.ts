import postgres, { type ListenMeta, type Sql, type TransactionSql } from "postgres";

import { AgentClosedError, UnknownAgentError } from "../domain/errors.js";
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
import {
  AgentId,
  type Clock,
  type Instant,
  Sequence,
  SystemClock,
  TenantId,
} from "../domain/value-objects.js";
import {
  type PostgresSslOptions,
  type PostgresTlsConfiguration,
  postgresSslOptions,
} from "../postgres-tls.js";
import { logSafeError } from "../safe-errors.js";
import type { E2eeMessageStore, E2eeMessageStoreProvider } from "./e2ee-message-store.js";
import type { InboxSubscription, InboxUpdateHandler, MessageStore } from "./message-store.js";
import {
  closePostgresAgent,
  endPostgresSession,
  getPostgresAgent,
  listPostgresAgents,
  registerPostgresAgent,
} from "./postgres-agent-lifecycle-store.js";
import { broadcastPostgresMessage } from "./postgres-broadcast-store.js";
import { sendPostgresMessage } from "./postgres-direct-message-store.js";
import {
  createPostgresE2eeMessageStore,
  type PostgresPlaintextInboxWatcher,
} from "./postgres-e2ee-message-store.js";
import { verifyPostgresE2eeSchema } from "./postgres-e2ee-schema.js";
import {
  getPostgresInboxVersion,
  getPostgresMessages,
  markPostgresMessagesRead,
  pruneExpiredPostgresMessages,
} from "./postgres-inbox-store.js";
import { prunePostgresLifecycle } from "./postgres-lifecycle-prune.js";
import { type InboxNotification, InboxNotificationSchema } from "./postgres-message-rows.js";
import { verifyPostgresMessageSchema } from "./postgres-message-schema.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";
import {
  listPostgresNotices,
  postPostgresNotice,
  prunePostgresNotices,
  resolvePostgresNotice,
  withdrawPostgresNotice,
} from "./postgres-notice-store.js";
import { normalizePostgresStorageError } from "./postgres-storage-errors.js";

export { POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED } from "./postgres-message-transactions.js";

const INBOX_CHANNEL: string = "murmur_inbox_changed";

type PostgresInboxSubscriber = {
  readonly agentId: AgentId;
  readonly handler: InboxUpdateHandler;
  readonly id: number;
  readonly tenantId: TenantId;
  lastSequence: Sequence;
};

type PostgresSharedState = {
  closed: boolean;
  listener: ListenMeta | null;
  nextSubscriberId: number;
  notificationQueue: Promise<void>;
  readonly subscribersByInbox: Map<string, Map<number, PostgresInboxSubscriber>>;
};

function subscriberInboxKey(tenantId: TenantId, agentId: AgentId): string {
  return `${tenantId.value}\u0000${agentId.value}`;
}

class CallbackInboxSubscription implements InboxSubscription {
  private readonly closeAction: () => void;
  private closed: boolean;

  public constructor(closeAction: () => void) {
    this.closeAction = closeAction;
    this.closed = false;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeAction();
  }
}

export class PostgresMessageStore implements MessageStore, E2eeMessageStoreProvider {
  private readonly clock: Clock;
  private readonly database: Sql;
  private readonly ownsDatabase: boolean;
  private readonly shared: PostgresSharedState;
  private readonly tenantId: TenantId;

  private constructor(
    database: Sql,
    clock: Clock,
    tenantId: TenantId,
    shared: PostgresSharedState,
    ownsDatabase: boolean,
  ) {
    this.clock = clock;
    this.database = database;
    this.ownsDatabase = ownsDatabase;
    this.shared = shared;
    this.tenantId = tenantId;
  }

  public static async connect(
    databaseUrl: string,
    tlsConfiguration: PostgresTlsConfiguration,
    clock: Clock = new SystemClock(),
  ): Promise<PostgresMessageStore> {
    const ssl: PostgresSslOptions = postgresSslOptions(databaseUrl, tlsConfiguration);
    const database: Sql = postgres(databaseUrl, {
      connect_timeout: 10,
      max: 4,
      ssl,
    });
    const shared: PostgresSharedState = {
      closed: false,
      listener: null,
      nextSubscriberId: 1,
      notificationQueue: Promise.resolve(),
      subscribersByInbox: new Map<string, Map<number, PostgresInboxSubscriber>>(),
    };
    const store: PostgresMessageStore = new PostgresMessageStore(
      database,
      clock,
      TenantId.founding(),
      shared,
      true,
    );
    try {
      await store.initialize();
      return store;
    } catch (error: unknown) {
      await database.end({ timeout: 1 });
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.shared.closed) throw new Error("The message store is closed");
  }

  public scope(tenantId: TenantId): MessageStore {
    this.ensureOpen();
    return new PostgresMessageStore(this.database, this.clock, tenantId, this.shared, false);
  }

  public scopeE2ee(tenantId: TenantId): E2eeMessageStore {
    this.ensureOpen();
    const scopedParent: PostgresMessageStore = new PostgresMessageStore(
      this.database,
      this.clock,
      tenantId,
      this.shared,
      false,
    );
    const watcher: PostgresPlaintextInboxWatcher = async (
      agentId: AgentId,
      afterSequence: Sequence,
      handler: InboxUpdateHandler,
    ): Promise<InboxSubscription> => await scopedParent.watchInbox(agentId, afterSequence, handler);
    return createPostgresE2eeMessageStore(
      this.database,
      this.clock,
      tenantId,
      (): void => this.ensureOpen(),
      watcher,
    );
  }

  private async setTenantContext(transaction: TransactionSql): Promise<void> {
    await setPostgresTenantContext(transaction, this.tenantId);
  }

  private async initialize(): Promise<void> {
    await this.ensureSchema();
    await this.pruneExpired(this.clock.now());
    const listener: ListenMeta = await this.database.listen(
      INBOX_CHANNEL,
      (payload: string): void => this.enqueueNotification(payload),
      (): void => this.enqueueCatchUp(),
    );
    this.shared.listener = listener;
  }

  private async ensureSchema(): Promise<void> {
    await verifyPostgresMessageSchema(this.database, this.tenantId);
    await verifyPostgresE2eeSchema(this.database);
  }

  private enqueueNotification(payload: string): void {
    const task: () => Promise<void> = async (): Promise<void> => {
      const parsedPayload: unknown = JSON.parse(payload);
      const notification: InboxNotification = InboxNotificationSchema.parse(parsedPayload);
      const tenantId: TenantId =
        notification.tenant_id === undefined
          ? TenantId.founding()
          : TenantId.parse(notification.tenant_id);
      await this.deliverUpdate(
        tenantId,
        AgentId.parse(notification.agent_id),
        Sequence.parse(notification.sequence),
      );
    };
    this.enqueue(task);
  }

  private enqueueCatchUp(): void {
    const task: () => Promise<void> = async (): Promise<void> => this.catchUpSubscribers();
    this.enqueue(task);
  }

  private enqueue(task: () => Promise<void>): void {
    const guardedTask: () => Promise<void> = async (): Promise<void> => {
      try {
        await task();
      } catch (error: unknown) {
        logSafeError("Murmur Postgres inbox listener error", error);
      }
    };
    this.shared.notificationQueue = this.shared.notificationQueue.then(guardedTask, guardedTask);
  }

  private async catchUpSubscribers(): Promise<void> {
    const subscribers: readonly PostgresInboxSubscriber[] = Array.from(
      this.shared.subscribersByInbox.values(),
    ).flatMap((inboxSubscribers: Map<number, PostgresInboxSubscriber>): PostgresInboxSubscriber[] =>
      Array.from(inboxSubscribers.values()),
    );
    let index: number = 0;
    while (index < subscribers.length) {
      const subscriber: PostgresInboxSubscriber | undefined = subscribers[index];
      if (subscriber === undefined) throw new Error("Inbox subscriber disappeared during catch-up");
      const scopedStore: MessageStore = this.scope(subscriber.tenantId);
      const currentSequence: Sequence = await scopedStore.getInboxVersion(subscriber.agentId);
      await this.deliverToSubscriber(subscriber, currentSequence);
      index += 1;
    }
  }

  private async deliverUpdate(
    tenantId: TenantId,
    agentId: AgentId,
    sequence: Sequence,
  ): Promise<void> {
    const inboxSubscribers: Map<number, PostgresInboxSubscriber> | undefined =
      this.shared.subscribersByInbox.get(subscriberInboxKey(tenantId, agentId));
    const subscribers: readonly PostgresInboxSubscriber[] =
      inboxSubscribers === undefined ? [] : Array.from(inboxSubscribers.values());
    let index: number = 0;
    while (index < subscribers.length) {
      const subscriber: PostgresInboxSubscriber | undefined = subscribers[index];
      if (subscriber === undefined) throw new Error("Inbox subscriber disappeared during delivery");
      await this.deliverToSubscriber(subscriber, sequence);
      index += 1;
    }
  }

  private async deliverToSubscriber(
    subscriber: PostgresInboxSubscriber,
    sequence: Sequence,
  ): Promise<void> {
    if (!sequence.isAfter(subscriber.lastSequence)) return;
    await subscriber.handler(sequence);
    subscriber.lastSequence = sequence;
  }

  public async registerAgent(command: RegisterAgentCommand): Promise<RegisterAgentResult> {
    this.ensureOpen();
    try {
      return await registerPostgresAgent(this.database, this.tenantId, command, this.clock.now());
    } catch (error: unknown) {
      throw normalizePostgresStorageError(error);
    }
  }

  public async getAgent(agentId: AgentId): Promise<Agent | null> {
    this.ensureOpen();
    return await getPostgresAgent(this.database, this.tenantId, agentId, this.clock.now());
  }

  public async listAgents(query: ListAgentsQuery): Promise<ListAgentsResult> {
    this.ensureOpen();
    await this.pruneExpired(this.clock.now());
    return await listPostgresAgents(this.database, this.tenantId, query, this.clock.now());
  }

  public async endSession(command: EndSessionCommand): Promise<EndSessionResult> {
    this.ensureOpen();
    return await endPostgresSession(this.database, this.tenantId, command, this.clock.now());
  }

  public async closeAgent(command: CloseAgentCommand): Promise<CloseAgentResult> {
    this.ensureOpen();
    try {
      return await closePostgresAgent(this.database, this.tenantId, command, this.clock.now());
    } catch (error: unknown) {
      throw normalizePostgresStorageError(error);
    }
  }

  public async broadcastMessage(command: BroadcastMessageCommand): Promise<BroadcastMessageResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await broadcastPostgresMessage(this.database, this.tenantId, command, now);
  }

  public async sendMessage(command: SendMessageCommand): Promise<SendMessageResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await sendPostgresMessage(this.database, this.tenantId, command, now);
  }

  private async requireAgent(agentId: AgentId): Promise<Agent> {
    const agent: Agent | null = await this.getAgent(agentId);
    if (agent === null) throw new UnknownAgentError(agentId.value);
    return agent;
  }

  public async getMessages(query: GetMessagesQuery): Promise<readonly Message[]> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    await this.requireAgent(query.agentId);
    return await getPostgresMessages(this.database, this.tenantId, query, now);
  }

  public async markMessagesRead(command: MarkMessagesReadCommand): Promise<MarkMessagesReadResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    await this.requireAgent(command.agentId);
    return await markPostgresMessagesRead(this.database, this.tenantId, command, now);
  }

  public async postNotice(command: PostNoticeCommand): Promise<PostNoticeResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    try {
      return await postPostgresNotice(this.database, this.tenantId, command, now);
    } catch (error: unknown) {
      throw normalizePostgresStorageError(error);
    }
  }

  public async listNotices(query: ListNoticesQuery): Promise<ListNoticesResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await listPostgresNotices(this.database, this.tenantId, query, now);
  }

  public async resolveNotice(command: ResolveNoticeCommand): Promise<ResolveNoticeResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await resolvePostgresNotice(this.database, this.tenantId, command, now);
  }

  public async withdrawNotice(command: WithdrawNoticeCommand): Promise<WithdrawNoticeResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await withdrawPostgresNotice(this.database, this.tenantId, command, now);
  }

  public async getInboxVersion(
    agentId: AgentId,
    generation: import("../domain/lifecycle-values.js").AgentGeneration | null = null,
  ): Promise<Sequence> {
    this.ensureOpen();
    return await getPostgresInboxVersion(
      this.database,
      this.tenantId,
      agentId,
      this.clock.now(),
      generation,
    );
  }

  public async watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): Promise<InboxSubscription> {
    this.ensureOpen();
    const agent: Agent = await this.requireAgent(agentId);
    if (agent.state === "closed") throw new AgentClosedError(agentId.value);
    const subscriberId: number = this.shared.nextSubscriberId;
    this.shared.nextSubscriberId += 1;
    const subscriber: PostgresInboxSubscriber = {
      agentId,
      handler,
      id: subscriberId,
      lastSequence: afterSequence,
      tenantId: this.tenantId,
    };
    const inboxKey: string = subscriberInboxKey(this.tenantId, agentId);
    const inboxSubscribers: Map<number, PostgresInboxSubscriber> =
      this.shared.subscribersByInbox.get(inboxKey) ?? new Map<number, PostgresInboxSubscriber>();
    inboxSubscribers.set(subscriberId, subscriber);
    this.shared.subscribersByInbox.set(inboxKey, inboxSubscribers);
    const closeAction: () => void = (): void => {
      inboxSubscribers.delete(subscriberId);
      if (inboxSubscribers.size === 0) this.shared.subscribersByInbox.delete(inboxKey);
    };
    const subscription: InboxSubscription = new CallbackInboxSubscription(closeAction);
    try {
      const currentSequence: Sequence = await this.getInboxVersion(agentId);
      await this.deliverToSubscriber(subscriber, currentSequence);
      return subscription;
    } catch (error: unknown) {
      await subscription.close();
      throw error;
    }
  }

  public async pruneExpired(now: Instant): Promise<number> {
    this.ensureOpen();
    try {
      const messageChanges: number = await pruneExpiredPostgresMessages(
        this.database,
        this.tenantId,
        now,
      );
      await this.database.begin(async (transaction: TransactionSql): Promise<void> => {
        await this.setTenantContext(transaction);
        await prunePostgresNotices(transaction, this.tenantId, now);
        await prunePostgresLifecycle(this.database, transaction, this.tenantId, now);
      });
      return messageChanges;
    } catch (error: unknown) {
      throw normalizePostgresStorageError(error);
    }
  }

  public async close(): Promise<void> {
    if (!this.ownsDatabase || this.shared.closed) return;
    this.shared.closed = true;
    this.shared.subscribersByInbox.clear();
    const listener: ListenMeta | null = this.shared.listener;
    this.shared.listener = null;
    if (listener !== null) await listener.unlisten();
    await this.shared.notificationQueue;
    await this.database.end({ timeout: 5 });
  }
}
