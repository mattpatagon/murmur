import postgres, { type ListenMeta, type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { RETENTION_DAYS } from "../domain/contracts.js";
import {
  IdempotencyConflictError,
  StorageCorruptionError,
  UnknownAgentError,
} from "../domain/errors.js";
import type {
  Agent,
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
  DisplayName,
  type Clock,
  Instant,
  JsonObjectSchema,
  MessageContent,
  MessageId,
  RepositoryName,
  Sequence,
  SystemClock,
  ThreadId,
  type JsonObject,
} from "../domain/value-objects.js";
import type { InboxSubscription, InboxUpdateHandler, MessageStore } from "./message-store.js";

const INBOX_CHANNEL: string = "murmur_inbox_changed";

type AgentRow = {
  readonly agent_id: string;
  readonly created_at: string;
  readonly display_name: string;
  readonly last_seen_at: string;
  readonly metadata_json: string;
};

type MessageRow = {
  readonly branch_name: string | null;
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

type CountRow = {
  readonly count: number;
};

type InboxVersionRow = {
  readonly version: number;
};

type SchemaProbeRow = {
  readonly agents_table: string | null;
  readonly branch_column: boolean;
  readonly client_column: boolean;
  readonly messages_table: string | null;
  readonly repository_column: boolean;
};

type InboxNotification = {
  readonly agent_id: string;
  readonly sequence: number;
};

type PostgresInboxSubscriber = {
  readonly agentId: AgentId;
  readonly handler: InboxUpdateHandler;
  readonly id: number;
  lastSequence: Sequence;
};

export type PostgresTlsConfiguration =
  | { readonly mode: "require" }
  | { readonly certificateAuthority: string; readonly mode: "verify-full" };

type VerifiedTlsOptions = {
  readonly ca: string;
  readonly rejectUnauthorized: true;
  readonly servername: string;
};

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

const CountRowSchema: z.ZodType<CountRow> = z.strictObject({
  count: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

const InboxVersionRowSchema: z.ZodType<InboxVersionRow> = z.strictObject({
  version: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

const SchemaProbeRowSchema: z.ZodType<SchemaProbeRow> = z.strictObject({
  agents_table: z.string().nullable(),
  branch_column: z.boolean(),
  client_column: z.boolean(),
  messages_table: z.string().nullable(),
  repository_column: z.boolean(),
});

const InboxNotificationSchema: z.ZodType<InboxNotification> = z.strictObject({
  agent_id: z.string(),
  sequence: SafeDatabaseIntegerSchema.pipe(z.number().nonnegative()),
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
  private readonly subscribers: Map<number, PostgresInboxSubscriber>;
  private closed: boolean;
  private listener: ListenMeta | null;
  private notificationQueue: Promise<void>;
  private nextSubscriberId: number;

  private constructor(database: Sql, clock: Clock) {
    this.clock = clock;
    this.closed = false;
    this.database = database;
    this.listener = null;
    this.nextSubscriberId = 1;
    this.notificationQueue = Promise.resolve();
    this.subscribers = new Map<number, PostgresInboxSubscriber>();
  }

  public static async connect(
    databaseUrl: string,
    tlsConfiguration: PostgresTlsConfiguration,
    clock: Clock = new SystemClock(),
  ): Promise<PostgresMessageStore> {
    const parsedUrl: URL = new URL(databaseUrl);
    const ssl: "require" | VerifiedTlsOptions =
      tlsConfiguration.mode === "require"
        ? "require"
        : {
            ca: tlsConfiguration.certificateAuthority,
            rejectUnauthorized: true,
            servername: parsedUrl.hostname,
          };
    const database: Sql = postgres(databaseUrl, {
      connect_timeout: 10,
      max: 4,
      ssl,
    });
    const store: PostgresMessageStore = new PostgresMessageStore(database, clock);
    try {
      await store.initialize();
      return store;
    } catch (error: unknown) {
      await database.end({ timeout: 1 });
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The message store is closed");
  }

  private async initialize(): Promise<void> {
    await this.ensureSchema();
    await this.pruneExpired(this.clock.now());
    const listener: ListenMeta = await this.database.listen(
      INBOX_CHANNEL,
      (payload: string): void => this.enqueueNotification(payload),
      (): void => this.enqueueCatchUp(),
    );
    this.listener = listener;
  }

  private async ensureSchema(): Promise<void> {
    const rawRows: unknown = await this.database`
      SELECT
        to_regclass('murmur.agents')::text AS agents_table,
        to_regclass('murmur.messages')::text AS messages_table,
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
            AND column_name = 'repository_name'
        ) AS repository_column
    `;
    const rows: SchemaProbeRow[] = z.array(SchemaProbeRowSchema).parse(rawRows);
    const row: SchemaProbeRow = firstRow(rows, "schema probe");
    if (
      row.agents_table === null ||
      row.messages_table === null ||
      !row.repository_column ||
      !row.branch_column ||
      !row.client_column
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
      await this.deliverUpdate(
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
    this.notificationQueue = this.notificationQueue.then(guardedTask, guardedTask);
  }

  private async catchUpSubscribers(): Promise<void> {
    const subscribers: readonly PostgresInboxSubscriber[] = Array.from(this.subscribers.values());
    let index: number = 0;
    while (index < subscribers.length) {
      const subscriber: PostgresInboxSubscriber | undefined = subscribers[index];
      if (subscriber === undefined) throw new Error("Inbox subscriber disappeared during catch-up");
      const currentSequence: Sequence = await this.getInboxVersion(subscriber.agentId);
      await this.deliverToSubscriber(subscriber, currentSequence);
      index += 1;
    }
  }

  private async deliverUpdate(agentId: AgentId, sequence: Sequence): Promise<void> {
    const subscribers: readonly PostgresInboxSubscriber[] = Array.from(this.subscribers.values());
    let index: number = 0;
    while (index < subscribers.length) {
      const subscriber: PostgresInboxSubscriber | undefined = subscribers[index];
      if (subscriber === undefined) throw new Error("Inbox subscriber disappeared during delivery");
      if (subscriber.agentId.equals(agentId)) {
        await this.deliverToSubscriber(subscriber, sequence);
      }
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
    const rawRows: unknown = await this.database`
      INSERT INTO murmur.agents(
        agent_id, display_name, metadata, created_at, last_seen_at
      )
      VALUES (
        ${command.agentId.value},
        ${command.displayName.value},
        ${this.database.json(command.metadata)},
        ${timestamp}::timestamptz,
        ${timestamp}::timestamptz
      )
      ON CONFLICT(agent_id) DO UPDATE SET
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
    `;
    const rows: AgentRow[] = z.array(AgentRowSchema).parse(rawRows);
    return mapAgentRow(firstRow(rows, "registered agent"));
  }

  public async getAgent(agentId: AgentId): Promise<Agent | null> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
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
      WHERE agent_id = ${agentId.value}
    `;
    const rows: AgentRow[] = z.array(AgentRowSchema).parse(rawRows);
    const row: AgentRow | undefined = rows[0];
    return row === undefined ? null : mapAgentRow(row);
  }

  public async listAgents(): Promise<readonly Agent[]> {
    this.ensureOpen();
    await this.pruneExpired(this.clock.now());
    const rawRows: unknown = await this.database`
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
      ORDER BY last_seen_at DESC, agent_id ASC
    `;
    const rows: AgentRow[] = z.array(AgentRowSchema).parse(rawRows);
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
      WHERE agent_id = ${senderId.value} OR agent_id = ${recipientId.value}
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

  public async sendMessage(command: SendMessageCommand): Promise<SendMessageResult> {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    await this.pruneExpired(now);
    return await this.database.begin(
      async (transaction: TransactionSql): Promise<SendMessageResult> => {
        await this.requireAgents(transaction, command.senderId, command.recipientId);
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
          ON CONFLICT(sender_id, idempotency_key) DO NOTHING
          RETURNING
            sequence,
            message_id::text AS message_id,
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
            WHERE agent_id = ${command.senderId.value}
          `;
          return { duplicate: false, message: mapMessageRow(insertedRow) };
        }
        if (command.idempotencyKey === null) {
          throw new Error("Message insert returned no row without an idempotency key");
        }
        const rawExistingRows: unknown = await transaction`
          SELECT
            sequence,
            message_id::text AS message_id,
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
          WHERE sender_id = ${command.senderId.value}
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
    const rawRows: unknown = await this.database`
      SELECT
        sequence,
        message_id::text AS message_id,
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
      WHERE recipient_id = ${query.agentId.value}
        AND sequence > ${query.afterSequence.value}
        AND expires_at > ${now.toISOString()}::timestamptz
        AND (${query.unreadOnly} = false OR read_at IS NULL)
        AND (${threadId}::text IS NULL OR thread_id = ${threadId})
      ORDER BY sequence ASC
      LIMIT ${query.limit}
    `;
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
    const rawRows: unknown = await this.database`
      UPDATE murmur.messages
      SET read_at = COALESCE(read_at, ${now.toISOString()}::timestamptz)
      WHERE recipient_id = ${command.agentId.value}
        AND message_id = ANY(${this.database.array(messageIds)}::uuid[])
        AND expires_at > ${now.toISOString()}::timestamptz
      RETURNING message_id::text AS message_id
    `;
    const rows: { readonly message_id: string }[] = z.array(MessageIdRowSchema).parse(rawRows);
    return { readAt: now, updated: rows.length };
  }

  public async getInboxVersion(agentId: AgentId): Promise<Sequence> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT COALESCE(MAX(sequence), 0) AS version
      FROM murmur.messages
      WHERE recipient_id = ${agentId.value}
        AND expires_at > ${this.clock.now().toISOString()}::timestamptz
    `;
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
    const subscriberId: number = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    const subscriber: PostgresInboxSubscriber = {
      agentId,
      handler,
      id: subscriberId,
      lastSequence: afterSequence,
    };
    this.subscribers.set(subscriberId, subscriber);
    const closeAction: () => void = (): void => {
      this.subscribers.delete(subscriberId);
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
    const rawRows: unknown = await this.database`
      WITH deleted AS (
        DELETE FROM murmur.messages
        WHERE expires_at <= ${now.toISOString()}::timestamptz
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `;
    const rows: CountRow[] = z.array(CountRowSchema).parse(rawRows);
    return firstRow(rows, "expiration count").count;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    const listener: ListenMeta | null = this.listener;
    this.listener = null;
    if (listener !== null) await listener.unlisten();
    await this.notificationQueue;
    await this.database.end({ timeout: 5 });
  }
}
