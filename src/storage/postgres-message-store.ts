import postgres, { type ListenMeta, type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { broadcastRequestMatches } from "../domain/broadcasts.js";
import { ACTIVE_AGENT_WINDOW_MINUTES, RETENTION_DAYS } from "../domain/contracts.js";
import {
  IdempotencyConflictError,
  StorageCorruptionError,
  UnknownAgentError,
} from "../domain/errors.js";
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
  AgentClient,
  AgentId,
  BranchName,
  BroadcastId,
  DisplayName,
  type Clock,
  Instant,
  JsonObjectSchema,
  MessageContent,
  MessageId,
  MachineName,
  RepositoryName,
  Sequence,
  SystemClock,
  TenantId,
  ThreadId,
  type JsonObject,
} from "../domain/value-objects.js";
import {
  postgresSslOptions,
  type PostgresTlsConfiguration,
  type PostgresSslOptions,
} from "../postgres-tls.js";
import type { InboxSubscription, InboxUpdateHandler, MessageStore } from "./message-store.js";

const INBOX_CHANNEL: string = "murmur_inbox_changed";
const MAX_AGENTS_PER_TENANT: number = 1_000;
const MAX_BROADCAST_RECIPIENTS: number = 100;
export const POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED: string = "671255459461899938";

type AgentRow = {
  readonly agent_id: string;
  readonly created_at: string;
  readonly display_name: string;
  readonly last_seen_at: string;
  readonly metadata_json: string;
};

type MessageRow = {
  readonly branch_name: string | null;
  readonly broadcast_id: string | null;
  readonly client_name: string | null;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly message_id: string;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly repository_name: string | null;
  readonly sender_id: string;
  readonly sequence: number;
  readonly thread_id: string;
};

type BroadcastRow = {
  readonly audience_machine_name: string | null;
  readonly audience_repository_name: string | null;
  readonly branch_name: string;
  readonly broadcast_id: string;
  readonly client_name: "claude" | "codex";
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_key: string | null;
  readonly repository_name: string;
  readonly sender_id: string;
  readonly thread_id: string;
};

type AgentIdRow = {
  readonly agent_id: string;
};

type CountRow = {
  readonly count: number;
};

type InboxVersionRow = {
  readonly version: number;
};

type SchemaProbeRow = {
  readonly agents_tenant_column: boolean;
  readonly agents_table: string | null;
  readonly branch_column: boolean;
  readonly broadcast_column: boolean;
  readonly broadcasts_tenant_column: boolean;
  readonly broadcasts_table: string | null;
  readonly client_column: boolean;
  readonly messages_tenant_column: boolean;
  readonly messages_tenant_sequence_column: boolean;
  readonly messages_table: string | null;
  readonly repository_column: boolean;
};

type InboxNotification = {
  readonly agent_id: string;
  readonly sequence: number;
  readonly tenant_id?: string | undefined;
};

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

const SafeDatabaseIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)), {
    message: "Postgres integer exceeds JavaScript's safe integer range",
  })
  .transform((value: bigint | number | string): number => Number(value));

const AgentRowSchema: z.ZodType<AgentRow> = z.strictObject({
  agent_id: z.string(),
  created_at: z.string(),
  display_name: z.string(),
  last_seen_at: z.string(),
  metadata_json: z.string(),
});

const MessageRowSchema: z.ZodType<MessageRow> = z.strictObject({
  branch_name: z.string().nullable(),
  broadcast_id: z.string().nullable(),
  client_name: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  message_id: z.string(),
  read_at: z.string().nullable(),
  recipient_id: z.string(),
  repository_name: z.string().nullable(),
  sender_id: z.string(),
  sequence: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
  thread_id: z.string(),
});

const BroadcastRowSchema: z.ZodType<BroadcastRow> = z.strictObject({
  audience_machine_name: z.string().nullable(),
  audience_repository_name: z.string().nullable(),
  branch_name: z.string(),
  broadcast_id: z.string(),
  client_name: z.enum(["claude", "codex"]),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  repository_name: z.string(),
  sender_id: z.string(),
  thread_id: z.string(),
});

const AgentIdRowSchema: z.ZodType<AgentIdRow> = z.strictObject({
  agent_id: z.string(),
});

const CountRowSchema: z.ZodType<CountRow> = z.strictObject({
  count: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

const InboxVersionRowSchema: z.ZodType<InboxVersionRow> = z.strictObject({
  version: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

const SchemaProbeRowSchema: z.ZodType<SchemaProbeRow> = z.strictObject({
  agents_tenant_column: z.boolean(),
  agents_table: z.string().nullable(),
  branch_column: z.boolean(),
  broadcast_column: z.boolean(),
  broadcasts_tenant_column: z.boolean(),
  broadcasts_table: z.string().nullable(),
  client_column: z.boolean(),
  messages_tenant_column: z.boolean(),
  messages_tenant_sequence_column: z.boolean(),
  messages_table: z.string().nullable(),
  repository_column: z.boolean(),
});

const InboxNotificationSchema: z.ZodType<InboxNotification> = z.strictObject({
  agent_id: z.string(),
  sequence: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
  tenant_id: z.string().uuid().optional(),
});

const MessageIdRowSchema: z.ZodType<{ readonly message_id: string }> = z.strictObject({
  message_id: z.string(),
});

function firstRow<T>(rows: readonly T[], entity: string): T {
  const row: T | undefined = rows[0];
  if (row === undefined) throw new StorageCorruptionError(entity, new Error("Missing row"));
  return row;
}

function mapAgentRow(input: unknown): Agent {
  try {
    const row: AgentRow = AgentRowSchema.parse(input);
    const parsedMetadata: unknown = JSON.parse(row.metadata_json);
    const metadata: JsonObject = JsonObjectSchema.parse(parsedMetadata);
    return {
      agentId: AgentId.parse(row.agent_id),
      createdAt: Instant.parse(row.created_at),
      displayName: DisplayName.parse(row.display_name),
      lastSeenAt: Instant.parse(row.last_seen_at),
      metadata,
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("agent", error);
  }
}

function mapMessageRow(input: unknown): Message {
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
      readAt,
      recipientId: AgentId.parse(row.recipient_id),
      repositoryName:
        row.repository_name === null ? null : RepositoryName.parse(row.repository_name),
      senderId: AgentId.parse(row.sender_id),
      sequence: Sequence.parse(row.sequence),
      threadId: ThreadId.parse(row.thread_id),
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("message", error);
  }
}

function minutesBefore(instant: Instant, minutes: number): Instant {
  return Instant.fromDate(new Date(instant.toEpochMilliseconds() - minutes * 60 * 1000));
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
    await transaction`
      SELECT pg_catalog.set_config('murmur.tenant_id', ${this.tenantId.value}, true)
    `;
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
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        SELECT
        to_regclass('murmur.agents')::text AS agents_table,
        to_regclass('murmur.broadcasts')::text AS broadcasts_table,
        to_regclass('murmur.messages')::text AS messages_table,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'agents'
            AND column_name = 'tenant_id'
        ) AS agents_tenant_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'broadcasts'
            AND column_name = 'tenant_id'
        ) AS broadcasts_tenant_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'messages'
            AND column_name = 'tenant_id'
        ) AS messages_tenant_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'messages'
            AND column_name = 'tenant_sequence'
        ) AS messages_tenant_sequence_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'messages'
            AND column_name = 'branch_name'
        ) AS branch_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'messages'
            AND column_name = 'client_name'
        ) AS client_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'messages'
            AND column_name = 'broadcast_id'
        ) AS broadcast_column,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'murmur'
            AND table_name = 'messages'
            AND column_name = 'repository_name'
        ) AS repository_column
      `,
    );
    const rows: SchemaProbeRow[] = z.array(SchemaProbeRowSchema).parse(rawRows);
    const row: SchemaProbeRow = firstRow(rows, "schema probe");
    if (
      row.agents_table === null ||
      row.broadcasts_table === null ||
      row.messages_table === null ||
      !row.agents_tenant_column ||
      !row.broadcasts_tenant_column ||
      !row.messages_tenant_column ||
      !row.messages_tenant_sequence_column ||
      !row.repository_column ||
      !row.branch_column ||
      !row.client_column ||
      !row.broadcast_column
    ) {
      throw new Error(
        "Murmur's Postgres schema is missing. Apply the committed Supabase migration first.",
      );
    }
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

  private async requireAgents(
    transaction: TransactionSql,
    senderId: AgentId,
    recipientId: AgentId,
  ): Promise<void> {
    const rawRows: unknown = await transaction`
      SELECT agent_id
      FROM murmur.agents
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND (agent_id = ${senderId.value} OR agent_id = ${recipientId.value})
    `;
    const rows: { readonly agent_id: string }[] = z
      .array(z.strictObject({ agent_id: z.string() }))
      .parse(rawRows);
    const knownIds: Set<string> = new Set<string>(
      rows.map((row: { readonly agent_id: string }): string => row.agent_id),
    );
    if (!knownIds.has(senderId.value)) throw new UnknownAgentError(senderId.value);
    if (!knownIds.has(recipientId.value)) throw new UnknownAgentError(recipientId.value);
  }

  private async requireBroadcastSender(
    transaction: TransactionSql,
    senderId: AgentId,
  ): Promise<void> {
    const rawRows: unknown = await transaction`
      SELECT agent_id
      FROM murmur.agents
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND agent_id = ${senderId.value}
    `;
    const rows: AgentIdRow[] = z.array(AgentIdRowSchema).parse(rawRows);
    if (rows.length === 0) throw new UnknownAgentError(senderId.value);
  }

  private async lockRecipientCommitOrder(
    transaction: TransactionSql,
    recipientIds: readonly string[],
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    const orderedRecipientIds: string[] = Array.from(recipientIds);
    await transaction`
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${this.tenantId.value}::text || ':' || recipient.agent_id,
          ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
        )
      )
      FROM unnest(${this.database.array(orderedRecipientIds)}::text[])
        WITH ORDINALITY AS recipient(agent_id, position)
      ORDER BY recipient.position
    `;
  }

  private async activeBroadcastRecipients(
    transaction: TransactionSql,
    senderId: AgentId,
    activeSince: string,
    repositoryName: string | null,
    machineName: string | null,
  ): Promise<readonly AgentIdRow[]> {
    let rawRows: unknown;
    if (repositoryName !== null && machineName !== null) {
      rawRows = await transaction`
        SELECT agent_id
        FROM murmur.agents
        WHERE tenant_id = ${this.tenantId.value}::uuid
          AND agent_id <> ${senderId.value}
          AND last_seen_at >= ${activeSince}::timestamptz
          AND metadata ->> 'repository' = ${repositoryName}
          AND metadata ->> 'machine' = ${machineName}
        ORDER BY agent_id ASC
        LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
      `;
    } else if (repositoryName !== null) {
      rawRows = await transaction`
        SELECT agent_id
        FROM murmur.agents
        WHERE tenant_id = ${this.tenantId.value}::uuid
          AND agent_id <> ${senderId.value}
          AND last_seen_at >= ${activeSince}::timestamptz
          AND metadata ->> 'repository' = ${repositoryName}
        ORDER BY agent_id ASC
        LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
      `;
    } else if (machineName !== null) {
      rawRows = await transaction`
        SELECT agent_id
        FROM murmur.agents
        WHERE tenant_id = ${this.tenantId.value}::uuid
          AND agent_id <> ${senderId.value}
          AND last_seen_at >= ${activeSince}::timestamptz
          AND metadata ->> 'machine' = ${machineName}
        ORDER BY agent_id ASC
        LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
      `;
    } else {
      rawRows = await transaction`
        SELECT agent_id
        FROM murmur.agents
        WHERE tenant_id = ${this.tenantId.value}::uuid
          AND agent_id <> ${senderId.value}
          AND last_seen_at >= ${activeSince}::timestamptz
        ORDER BY agent_id ASC
        LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
      `;
    }
    const rows: AgentIdRow[] = z.array(AgentIdRowSchema).parse(rawRows);
    if (rows.length > MAX_BROADCAST_RECIPIENTS) {
      throw new Error(`Broadcasts are limited to ${MAX_BROADCAST_RECIPIENTS} recipients`);
    }
    return rows;
  }

  private async broadcastResult(
    transaction: TransactionSql,
    row: BroadcastRow,
    duplicate: boolean,
  ): Promise<BroadcastMessageResult> {
    const broadcastId: BroadcastId = BroadcastId.parse(row.broadcast_id);
    const rawCountRows: unknown = await transaction`
      SELECT COUNT(*) AS count
      FROM murmur.messages
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND broadcast_id = ${broadcastId.value}::uuid
    `;
    const countRows: CountRow[] = z.array(CountRowSchema).parse(rawCountRows);
    return {
      audience: {
        machineName:
          row.audience_machine_name === null ? null : MachineName.parse(row.audience_machine_name),
        repositoryName:
          row.audience_repository_name === null
            ? null
            : RepositoryName.parse(row.audience_repository_name),
      },
      broadcastId,
      createdAt: Instant.parse(row.created_at),
      duplicate,
      expiresAt: Instant.parse(row.expires_at),
      recipientCount: firstRow(countRows, "broadcast recipient count").count,
      threadId: ThreadId.parse(row.thread_id),
    };
  }

  public async broadcastMessage(command: BroadcastMessageCommand): Promise<BroadcastMessageResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    if (command.repositoryName === null || command.branchName === null || command.client === null) {
      throw new Error("Broadcast message context must include repository, branch, and client");
    }
    const repositoryName: string = command.repositoryName.value;
    const branchName: string = command.branchName.value;
    const clientName: string = command.client.value;

    return await this.database.begin(
      async (transaction: TransactionSql): Promise<BroadcastMessageResult> => {
        await this.setTenantContext(transaction);
        await this.requireBroadcastSender(transaction, command.senderId);
        const broadcastId: BroadcastId = BroadcastId.generate();
        const threadId: ThreadId =
          command.threadId === null ? ThreadId.generate() : command.threadId;
        const createdAt: string = now.toISOString();
        const expiresAt: string = now.addDays(RETENTION_DAYS).toISOString();
        const audienceRepository: string | null =
          command.audience.repositoryName === null ? null : command.audience.repositoryName.value;
        const audienceMachine: string | null =
          command.audience.machineName === null ? null : command.audience.machineName.value;
        const idempotencyKey: string | null =
          command.idempotencyKey === null ? null : command.idempotencyKey.value;
        const rawInsertedRows: unknown = await transaction`
          INSERT INTO murmur.broadcasts(
            tenant_id,
            broadcast_id,
            thread_id,
            sender_id,
            content,
            repository_name,
            branch_name,
            client_name,
            audience_repository_name,
            audience_machine_name,
            idempotency_key,
            created_at,
            expires_at
          )
          VALUES (
            ${this.tenantId.value}::uuid,
            ${broadcastId.value}::uuid,
            ${threadId.value},
            ${command.senderId.value},
            ${command.content.value},
            ${repositoryName},
            ${branchName},
            ${clientName},
            ${audienceRepository},
            ${audienceMachine},
            ${idempotencyKey},
            ${createdAt}::timestamptz,
            ${expiresAt}::timestamptz
          )
          ON CONFLICT(tenant_id, sender_id, idempotency_key) DO NOTHING
          RETURNING
            broadcast_id::text AS broadcast_id,
            thread_id,
            sender_id,
            content,
            repository_name,
            branch_name,
            client_name,
            audience_repository_name,
            audience_machine_name,
            idempotency_key,
            to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS created_at,
            to_char(
              expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS expires_at
        `;
        const insertedRows: BroadcastRow[] = z.array(BroadcastRowSchema).parse(rawInsertedRows);
        const inserted: BroadcastRow | undefined = insertedRows[0];
        if (inserted === undefined) {
          if (command.idempotencyKey === null) {
            throw new Error("Broadcast insert returned no row without an idempotency key");
          }
          const rawExistingRows: unknown = await transaction`
            SELECT
              broadcast_id::text AS broadcast_id,
              thread_id,
              sender_id,
              content,
              repository_name,
              branch_name,
              client_name,
              audience_repository_name,
              audience_machine_name,
              idempotency_key,
              to_char(
                created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS created_at,
              to_char(
                expires_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS expires_at
            FROM murmur.broadcasts
            WHERE tenant_id = ${this.tenantId.value}::uuid
              AND sender_id = ${command.senderId.value}
              AND idempotency_key = ${command.idempotencyKey.value}
          `;
          const existingRows: BroadcastRow[] = z.array(BroadcastRowSchema).parse(rawExistingRows);
          const existing: BroadcastRow = firstRow(existingRows, "idempotent broadcast");
          if (
            !broadcastRequestMatches(
              {
                audienceMachineName: existing.audience_machine_name,
                audienceRepositoryName: existing.audience_repository_name,
                branchName: existing.branch_name,
                clientName: existing.client_name,
                content: existing.content,
                repositoryName: existing.repository_name,
                threadId: existing.thread_id,
              },
              command,
            )
          ) {
            throw new IdempotencyConflictError(command.idempotencyKey.value);
          }
          return await this.broadcastResult(transaction, existing, true);
        }

        const activeSince: string = minutesBefore(now, ACTIVE_AGENT_WINDOW_MINUTES).toISOString();
        const recipientRows: readonly AgentIdRow[] = await this.activeBroadcastRecipients(
          transaction,
          command.senderId,
          activeSince,
          audienceRepository,
          audienceMachine,
        );
        if (recipientRows.length > 0) {
          const messageIds: string[] = recipientRows.map((): string => MessageId.generate().value);
          const recipientIds: string[] = recipientRows.map(
            (recipient: AgentIdRow): string => recipient.agent_id,
          );
          await this.lockRecipientCommitOrder(transaction, recipientIds);
          await transaction`
            INSERT INTO murmur.messages(
              tenant_id,
              message_id,
              thread_id,
              sender_id,
              recipient_id,
              broadcast_id,
              content,
              repository_name,
              branch_name,
              client_name,
              created_at,
              expires_at
            )
            SELECT
              ${this.tenantId.value}::uuid,
              delivery.message_id,
              ${threadId.value},
              ${command.senderId.value},
              delivery.recipient_id,
              ${broadcastId.value}::uuid,
              ${command.content.value},
              ${repositoryName},
              ${branchName},
              ${clientName},
              ${createdAt}::timestamptz,
              ${expiresAt}::timestamptz
            FROM unnest(
              ${this.database.array(messageIds)}::uuid[],
              ${this.database.array(recipientIds)}::text[]
            ) AS delivery(message_id, recipient_id)
          `;
        }
        await transaction`
          UPDATE murmur.agents
          SET last_seen_at = ${createdAt}::timestamptz
          WHERE tenant_id = ${this.tenantId.value}::uuid
            AND agent_id = ${command.senderId.value}
        `;
        return await this.broadcastResult(transaction, inserted, false);
      },
    );
  }

  public async sendMessage(command: SendMessageCommand): Promise<SendMessageResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await this.database.begin(
      async (transaction: TransactionSql): Promise<SendMessageResult> => {
        await this.setTenantContext(transaction);
        await this.requireAgents(transaction, command.senderId, command.recipientId);
        await this.lockRecipientCommitOrder(transaction, [command.recipientId.value]);
        const messageId: MessageId = MessageId.generate();
        const threadId: ThreadId =
          command.threadId === null ? ThreadId.generate() : command.threadId;
        const createdAt: string = now.toISOString();
        const expiresAt: string = now.addDays(RETENTION_DAYS).toISOString();
        const idempotencyKey: string | null =
          command.idempotencyKey === null ? null : command.idempotencyKey.value;
        const repositoryName: string | null =
          command.repositoryName === null ? null : command.repositoryName.value;
        const branchName: string | null =
          command.branchName === null ? null : command.branchName.value;
        const clientName: string | null = command.client === null ? null : command.client.value;
        const rawInsertedRows: unknown = await transaction`
          INSERT INTO murmur.messages(
            tenant_id,
            message_id,
            thread_id,
            sender_id,
            recipient_id,
            content,
            repository_name,
            branch_name,
            client_name,
            idempotency_key,
            created_at,
            expires_at
          )
          VALUES (
            ${this.tenantId.value}::uuid,
            ${messageId.value}::uuid,
            ${threadId.value},
            ${command.senderId.value},
            ${command.recipientId.value},
            ${command.content.value},
            ${repositoryName},
            ${branchName},
            ${clientName},
            ${idempotencyKey},
            ${createdAt}::timestamptz,
            ${expiresAt}::timestamptz
          )
          ON CONFLICT(tenant_id, sender_id, idempotency_key) DO NOTHING
          RETURNING
            tenant_sequence AS sequence,
            message_id::text AS message_id,
            broadcast_id::text AS broadcast_id,
            thread_id,
            sender_id,
            recipient_id,
            content,
            repository_name,
            branch_name,
            client_name,
            to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS created_at,
            to_char(
              expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS expires_at,
            CASE
              WHEN read_at IS NULL THEN NULL
              ELSE to_char(
                read_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            END AS read_at
        `;
        const insertedRows: MessageRow[] = z.array(MessageRowSchema).parse(rawInsertedRows);
        const insertedRow: MessageRow | undefined = insertedRows[0];
        if (insertedRow !== undefined) {
          await transaction`
            UPDATE murmur.agents
            SET last_seen_at = ${createdAt}::timestamptz
            WHERE tenant_id = ${this.tenantId.value}::uuid
              AND agent_id = ${command.senderId.value}
          `;
          return { duplicate: false, message: mapMessageRow(insertedRow) };
        }
        if (command.idempotencyKey === null) {
          throw new Error("Message insert returned no row without an idempotency key");
        }
        const rawExistingRows: unknown = await transaction`
          SELECT
            tenant_sequence AS sequence,
            message_id::text AS message_id,
            broadcast_id::text AS broadcast_id,
            thread_id,
            sender_id,
            recipient_id,
            content,
            repository_name,
            branch_name,
            client_name,
            to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS created_at,
            to_char(
              expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS expires_at,
            CASE
              WHEN read_at IS NULL THEN NULL
              ELSE to_char(
                read_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            END AS read_at
          FROM murmur.messages
          WHERE tenant_id = ${this.tenantId.value}::uuid
            AND sender_id = ${command.senderId.value}
            AND idempotency_key = ${command.idempotencyKey.value}
        `;
        const existingRows: MessageRow[] = z.array(MessageRowSchema).parse(rawExistingRows);
        const existing: Message = mapMessageRow(firstRow(existingRows, "idempotent message"));
        const sameThread: boolean =
          command.threadId === null || existing.threadId.value === command.threadId.value;
        const sameRequest: boolean =
          existing.recipientId.equals(command.recipientId) &&
          existing.content.value === command.content.value &&
          ((existing.branchName === null && command.branchName === null) ||
            (existing.branchName !== null &&
              command.branchName !== null &&
              existing.branchName.equals(command.branchName))) &&
          ((existing.client === null && command.client === null) ||
            (existing.client !== null &&
              command.client !== null &&
              existing.client.equals(command.client))) &&
          ((existing.repositoryName === null && command.repositoryName === null) ||
            (existing.repositoryName !== null &&
              command.repositoryName !== null &&
              existing.repositoryName.equals(command.repositoryName))) &&
          sameThread;
        if (!sameRequest) throw new IdempotencyConflictError(command.idempotencyKey.value);
        return { duplicate: true, message: existing };
      },
    );
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
    const threadId: string | null = query.threadId === null ? null : query.threadId.value;
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        SELECT
        tenant_sequence AS sequence,
        message_id::text AS message_id,
        broadcast_id::text AS broadcast_id,
        thread_id,
        sender_id,
        recipient_id,
        content,
        repository_name,
        branch_name,
        client_name,
        to_char(
          created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS created_at,
        to_char(
          expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS expires_at,
        CASE
          WHEN read_at IS NULL THEN NULL
          ELSE to_char(
            read_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        END AS read_at
      FROM murmur.messages
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND recipient_id = ${query.agentId.value}
        AND tenant_sequence > ${query.afterSequence.value}
        AND expires_at > ${now.toISOString()}::timestamptz
        AND (${query.unreadOnly} = false OR read_at IS NULL)
        AND (${threadId}::text IS NULL OR thread_id = ${threadId})
      ORDER BY tenant_sequence ASC
      LIMIT ${query.limit}
      `,
    );
    const rows: MessageRow[] = z.array(MessageRowSchema).parse(rawRows);
    return rows.map((row: MessageRow): Message => mapMessageRow(row));
  }

  public async markMessagesRead(command: MarkMessagesReadCommand): Promise<MarkMessagesReadResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    await this.requireAgent(command.agentId);
    if (command.messageIds.length === 0) return { readAt: now, updated: 0 };
    const messageIds: string[] = command.messageIds.map(
      (messageId: MessageId): string => messageId.value,
    );
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        UPDATE murmur.messages
      SET read_at = COALESCE(read_at, ${now.toISOString()}::timestamptz)
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND recipient_id = ${command.agentId.value}
        AND message_id = ANY(${this.database.array(messageIds)}::uuid[])
        AND expires_at > ${now.toISOString()}::timestamptz
      RETURNING message_id::text AS message_id
      `,
    );
    const rows: { readonly message_id: string }[] = z.array(MessageIdRowSchema).parse(rawRows);
    return { readAt: now, updated: rows.length };
  }

  public async getInboxVersion(agentId: AgentId): Promise<Sequence> {
    this.ensureOpen();
    const rawRows: unknown = await this.inTenantTransaction(
      async (transaction: TransactionSql): Promise<unknown> =>
        await transaction`
        SELECT COALESCE(MAX(tenant_sequence), 0) AS version
      FROM murmur.messages
      WHERE tenant_id = ${this.tenantId.value}::uuid
        AND recipient_id = ${agentId.value}
        AND expires_at > ${this.clock.now().toISOString()}::timestamptz
      `,
    );
    const rows: InboxVersionRow[] = z.array(InboxVersionRowSchema).parse(rawRows);
    return Sequence.parse(firstRow(rows, "inbox version").version);
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
    return await this.database.begin(async (transaction: TransactionSql): Promise<number> => {
      await this.setTenantContext(transaction);
      const rawRows: unknown = await transaction`
        WITH expired AS (
          SELECT tenant_id, tenant_sequence
          FROM murmur.messages
          WHERE tenant_id = ${this.tenantId.value}::uuid
            AND expires_at <= ${now.toISOString()}::timestamptz
          ORDER BY tenant_sequence
          LIMIT 1000
        ), deleted AS (
          DELETE FROM murmur.messages AS message
          USING expired
          WHERE message.tenant_id = expired.tenant_id
            AND message.tenant_sequence = expired.tenant_sequence
          RETURNING 1
        )
        SELECT COUNT(*) AS count FROM deleted
      `;
      await transaction`
        DELETE FROM murmur.broadcasts AS broadcast
        USING (
          SELECT tenant_id, broadcast_id
          FROM murmur.broadcasts
          WHERE tenant_id = ${this.tenantId.value}::uuid
            AND expires_at <= ${now.toISOString()}::timestamptz
          ORDER BY expires_at, broadcast_id
          LIMIT 1000
        ) AS expired
        WHERE broadcast.tenant_id = expired.tenant_id
          AND broadcast.broadcast_id = expired.broadcast_id
      `;
      const rows: CountRow[] = z.array(CountRowSchema).parse(rawRows);
      return firstRow(rows, "expiration count").count;
    });
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
