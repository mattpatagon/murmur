import postgres, { type ListenMeta, type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { UnknownAgentError } from "../domain/errors.js";
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
import type { InboxSubscription, InboxUpdateHandler, MessageStore } from "./message-store.js";
import { broadcastPostgresMessage } from "./postgres-broadcast-store.js";
import { sendPostgresMessage } from "./postgres-direct-message-store.js";
import {
  getPostgresInboxVersion,
  getPostgresMessages,
  markPostgresMessagesRead,
  pruneExpiredPostgresMessages,
} from "./postgres-inbox-store.js";
import {
  type AgentRow,
  AgentRowSchema,
  firstRow,
  type InboxNotification,
  InboxNotificationSchema,
  mapAgentRow,
} from "./postgres-message-rows.js";
import { verifyPostgresMessageSchema } from "./postgres-message-schema.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

export { POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED } from "./postgres-message-transactions.js";

const INBOX_CHANNEL: string = "murmur_inbox_changed";
const MAX_AGENTS_PER_TENANT: number = 1_000;

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

export class PostgresMessageStore implements MessageStore {
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

  private async setTenantContext(transaction: TransactionSql): Promise<void> {
    await setPostgresTenantContext(transaction, this.tenantId);
  }

  private async inTenantTransaction(
    action: (transaction: TransactionSql) => Promise<unknown>,
  ): Promise<unknown> {
    return await this.database.begin(async (transaction: TransactionSql): Promise<unknown> => {
      await this.setTenantContext(transaction);
      return await action(transaction);
    });
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
        console.error("Murmur Postgres inbox listener error:", error);
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

  public async registerAgent(command: RegisterAgentCommand): Promise<Agent> {
    this.ensureOpen();
    const timestamp: string = this.clock.now().toISOString();
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        INSERT INTO murmur.agents(
        tenant_id, agent_id, display_name, metadata, created_at, last_seen_at
      )
      VALUES (
        ${this.tenantId.value}::uuid,
        ${command.agentId.value},
        ${command.displayName.value},
        ${this.database.json(command.metadata)},
        ${timestamp}::timestamptz,
        ${timestamp}::timestamptz
      )
      ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
        display_name = excluded.display_name,
        metadata = excluded.metadata,
        last_seen_at = excluded.last_seen_at
      RETURNING
        agent_id,
        display_name,
        metadata::text AS metadata_json,
        to_char(
          created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS created_at,
        to_char(
          last_seen_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS last_seen_at
      `,
    );
    const rows: AgentRow[] = z.array(AgentRowSchema).parse(rawRows);
    return mapAgentRow(firstRow(rows, "registered agent"));
  }

  public async getAgent(agentId: AgentId): Promise<Agent | null> {
    this.ensureOpen();
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        SELECT
        agent_id,
        display_name,
        metadata::text AS metadata_json,
        to_char(
          created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS created_at,
        to_char(
          last_seen_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS last_seen_at
      FROM murmur.agents
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND agent_id = ${agentId.value}
      `,
    );
    const rows: AgentRow[] = z.array(AgentRowSchema).parse(rawRows);
    const row: AgentRow | undefined = rows[0];
    return row === undefined ? null : mapAgentRow(row);
  }

  public async listAgents(): Promise<readonly Agent[]> {
    this.ensureOpen();
    await this.pruneExpired(this.clock.now());
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        SELECT
        agent_id,
        display_name,
        metadata::text AS metadata_json,
        to_char(
          created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS created_at,
        to_char(
          last_seen_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS last_seen_at
      FROM murmur.agents
      WHERE tenant_id = ${this.tenantId.value}::uuid
      ORDER BY last_seen_at DESC, agent_id ASC
      LIMIT ${MAX_AGENTS_PER_TENANT + 1}
      `,
    );
    const rows: AgentRow[] = z.array(AgentRowSchema).parse(rawRows);
    if (rows.length > MAX_AGENTS_PER_TENANT) {
      throw new Error("Tenant agent quota invariant exceeded");
    }
    return rows.map((row: AgentRow): Agent => mapAgentRow(row));
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

  public async getInboxVersion(agentId: AgentId): Promise<Sequence> {
    this.ensureOpen();
    return await getPostgresInboxVersion(this.database, this.tenantId, agentId, this.clock.now());
  }

  public async watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): Promise<InboxSubscription> {
    this.ensureOpen();
    await this.requireAgent(agentId);
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
    return await pruneExpiredPostgresMessages(this.database, this.tenantId, now);
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
