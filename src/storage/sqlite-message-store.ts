import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database, type Changes, type Statement } from "bun:sqlite";
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

const SQLITE_WATCH_INTERVAL_MS: number = 200;
type IntervalHandle = ReturnType<typeof setInterval>;

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
  readonly idempotency_key: string | null;
  readonly message_id: string;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly repository_name: string | null;
  readonly sender_id: string;
  readonly sequence: number;
  readonly thread_id: string;
};

type UserVersionRow = {
  readonly user_version: number;
};

type InboxVersionRow = {
  readonly version: number;
};

const AgentRowSchema: z.ZodType<AgentRow> = z.strictObject({
  agent_id: z.string(),
  created_at: z.string(),
  display_name: z.string(),
  last_seen_at: z.string(),
  metadata_json: z.string(),
});
const SafeSqlIntegerSchema: z.ZodType<number> = z
  .union([z.number().int(), z.bigint()])
  .refine((value: number | bigint): boolean => Number.isSafeInteger(Number(value)), {
    message: "SQLite integer exceeds JavaScript's safe integer range",
  })
  .transform((value: number | bigint): number => Number(value));
const MessageRowSchema: z.ZodType<MessageRow> = z.strictObject({
  branch_name: z.string().nullable(),
  client_name: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  message_id: z.string(),
  read_at: z.string().nullable(),
  recipient_id: z.string(),
  repository_name: z.string().nullable(),
  sender_id: z.string(),
  sequence: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
  thread_id: z.string(),
});
const UserVersionRowSchema: z.ZodType<UserVersionRow> = z.strictObject({
  user_version: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
});
const InboxVersionRowSchema: z.ZodType<InboxVersionRow> = z.strictObject({
  version: SafeSqlIntegerSchema.pipe(z.number().nonnegative()),
});

function parseJsonObject(input: string): JsonObject {
  const parsed: unknown = JSON.parse(input);
  return JsonObjectSchema.parse(parsed);
}

function mapAgentRow(input: unknown): Agent {
  try {
    const row: AgentRow = AgentRowSchema.parse(input);
    return {
      agentId: AgentId.parse(row.agent_id),
      createdAt: Instant.parse(row.created_at),
      displayName: DisplayName.parse(row.display_name),
      lastSeenAt: Instant.parse(row.last_seen_at),
      metadata: parseJsonObject(row.metadata_json),
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

class SqliteInboxSubscription implements InboxSubscription {
  private readonly agentId: AgentId;
  private readonly handler: InboxUpdateHandler;
  private readonly store: SqliteMessageStore;
  private closed: boolean;
  private previousSequence: Sequence;
  private running: boolean;
  private timer: IntervalHandle | null;

  public constructor(
    store: SqliteMessageStore,
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ) {
    this.agentId = agentId;
    this.closed = false;
    this.handler = handler;
    this.previousSequence = afterSequence;
    this.running = false;
    this.store = store;
    this.timer = setInterval((): void => {
      void this.check();
    }, SQLITE_WATCH_INTERVAL_MS);
    void this.check();
  }

  private async check(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const currentSequence: Sequence = this.store.getInboxVersion(this.agentId);
      if (currentSequence.isAfter(this.previousSequence)) {
        await this.handler(currentSequence);
        this.previousSequence = currentSequence;
      }
    } catch (error: unknown) {
      console.error("Murmur SQLite inbox watcher error:", error);
    } finally {
      this.running = false;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export class SqliteMessageStore implements MessageStore {
  private readonly clock: Clock;
  private readonly database: Database;
  private closed: boolean;

  public constructor(databasePath: string, clock: Clock = new SystemClock()) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.clock = clock;
    this.closed = false;
    this.database = new Database(databasePath, {
      create: true,
      readwrite: true,
      safeIntegers: true,
      strict: true,
    });
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.pruneExpired(this.clock.now());
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The message store is closed");
  }

  private schemaVersion(): number {
    const statement: Statement<unknown, []> = this.database.query("PRAGMA user_version");
    const row: UserVersionRow = UserVersionRowSchema.parse(statement.get());
    return row.user_version;
  }

  private migrate(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let version: number = this.schemaVersion();
      if (version > 3) {
        throw new Error(
          `Database schema version ${version} is newer than this Murmur build supports`,
        );
      }
      if (version === 0) {
        this.database.exec(`
          CREATE TABLE agents (
            agent_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
          );

          CREATE TABLE messages (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE,
            thread_id TEXT NOT NULL,
            sender_id TEXT NOT NULL REFERENCES agents(agent_id),
            recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
            content TEXT NOT NULL,
            repository_name TEXT,
            branch_name TEXT CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 500),
            client_name TEXT CHECK(client_name IS NULL OR client_name IN ('claude', 'codex')),
            idempotency_key TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            read_at TEXT,
            UNIQUE(sender_id, idempotency_key)
          );

          CREATE INDEX messages_recipient_sequence
            ON messages(recipient_id, sequence);
          CREATE INDEX messages_recipient_unread
            ON messages(recipient_id, read_at, sequence);
          CREATE INDEX messages_thread_sequence
            ON messages(thread_id, sequence);
          CREATE INDEX messages_expiration
            ON messages(expires_at);

          PRAGMA user_version = 3;
        `);
        version = 3;
      }
      if (version === 1) {
        this.database.exec(`
          ALTER TABLE messages ADD COLUMN repository_name TEXT;
          PRAGMA user_version = 2;
        `);
        version = 2;
      }
      if (version === 2) {
        this.database.exec(`
          ALTER TABLE messages ADD COLUMN branch_name TEXT
            CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 500);
          ALTER TABLE messages ADD COLUMN client_name TEXT
            CHECK(client_name IS NULL OR client_name IN ('claude', 'codex'));
          PRAGMA user_version = 3;
        `);
      }
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireAgent(agentId: AgentId): Agent {
    const agent: Agent | null = this.getAgent(agentId);
    if (agent === null) throw new UnknownAgentError(agentId.value);
    return agent;
  }

  public registerAgent(command: RegisterAgentCommand): Agent {
    this.ensureOpen();
    const timestamp: string = this.clock.now().toISOString();
    const statement: Statement<unknown, [string, string, string, string, string]> =
      this.database.query(`
        INSERT INTO agents(agent_id, display_name, metadata_json, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          display_name = excluded.display_name,
          metadata_json = excluded.metadata_json,
          last_seen_at = excluded.last_seen_at
      `);
    statement.run(
      command.agentId.value,
      command.displayName.value,
      JSON.stringify(command.metadata),
      timestamp,
      timestamp,
    );
    return this.requireAgent(command.agentId);
  }

  public getAgent(agentId: AgentId): Agent | null {
    this.ensureOpen();
    const statement: Statement<unknown, [string]> = this.database.query(
      "SELECT * FROM agents WHERE agent_id = ?",
    );
    const row: unknown = statement.get(agentId.value);
    return row === null ? null : mapAgentRow(row);
  }

  public listAgents(): readonly Agent[] {
    this.ensureOpen();
    this.pruneExpired(this.clock.now());
    const statement: Statement<unknown, []> = this.database.query(`
      SELECT * FROM agents
      ORDER BY last_seen_at DESC, agent_id ASC
    `);
    const rows: unknown[] = statement.all();
    return rows.map((row: unknown): Agent => mapAgentRow(row));
  }

  public sendMessage(command: SendMessageCommand): SendMessageResult {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    this.requireAgent(command.senderId);
    this.requireAgent(command.recipientId);

    if (command.idempotencyKey !== null) {
      const existingStatement: Statement<unknown, [string, string]> = this.database.query(`
        SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?
      `);
      const existingRow: unknown = existingStatement.get(
        command.senderId.value,
        command.idempotencyKey.value,
      );
      if (existingRow !== null) {
        const existing: Message = mapMessageRow(existingRow);
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
      }
    }

    const messageId: MessageId = MessageId.generate();
    const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
    const createdAt: string = now.toISOString();
    const expiresAt: string = now.addDays(RETENTION_DAYS).toISOString();
    const idempotencyKey: string | null =
      command.idempotencyKey === null ? null : command.idempotencyKey.value;
    const repositoryName: string | null =
      command.repositoryName === null ? null : command.repositoryName.value;
    const branchName: string | null = command.branchName === null ? null : command.branchName.value;
    const clientName: string | null = command.client === null ? null : command.client.value;
    const insertStatement: Statement<
      unknown,
      [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    > = this.database.query(`
      INSERT INTO messages(
        message_id, thread_id, sender_id, recipient_id, content,
        repository_name, branch_name, client_name, idempotency_key, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      messageId.value,
      threadId.value,
      command.senderId.value,
      command.recipientId.value,
      command.content.value,
      repositoryName,
      branchName,
      clientName,
      idempotencyKey,
      createdAt,
      expiresAt,
    );
    const updateAgentStatement: Statement<unknown, [string, string]> = this.database.query(
      "UPDATE agents SET last_seen_at = ? WHERE agent_id = ?",
    );
    updateAgentStatement.run(createdAt, command.senderId.value);

    const storedStatement: Statement<unknown, [string]> = this.database.query(
      "SELECT * FROM messages WHERE message_id = ?",
    );
    const storedRow: unknown = storedStatement.get(messageId.value);
    if (storedRow === null) throw new Error("Inserted message could not be read back");
    return { duplicate: false, message: mapMessageRow(storedRow) };
  }

  public getMessages(query: GetMessagesQuery): readonly Message[] {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    this.requireAgent(query.agentId);
    const unreadFlag: number = query.unreadOnly ? 1 : 0;
    const threadId: string | null = query.threadId === null ? null : query.threadId.value;
    const statement: Statement<
      unknown,
      [string, number, number, string | null, string | null, number]
    > = this.database.query(`
      SELECT * FROM messages
      WHERE recipient_id = ?
        AND sequence > ?
        AND (? = 0 OR read_at IS NULL)
        AND (? IS NULL OR thread_id = ?)
      ORDER BY sequence ASC
      LIMIT ?
    `);
    const rows: unknown[] = statement.all(
      query.agentId.value,
      query.afterSequence.value,
      unreadFlag,
      threadId,
      threadId,
      query.limit,
    );
    return rows.map((row: unknown): Message => mapMessageRow(row));
  }

  public markMessagesRead(command: MarkMessagesReadCommand): MarkMessagesReadResult {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    this.requireAgent(command.agentId);
    if (command.messageIds.length === 0) return { readAt: now, updated: 0 };

    const serializedMessageIds: string = JSON.stringify(
      command.messageIds.map((messageId: MessageId): string => messageId.value),
    );
    const updateStatement: Statement<unknown, [string, string, string]> = this.database.query(`
      UPDATE messages
      SET read_at = COALESCE(read_at, ?)
      WHERE recipient_id = ?
        AND message_id IN (SELECT value FROM json_each(?))
    `);
    const changes: Changes = updateStatement.run(
      now.toISOString(),
      command.agentId.value,
      serializedMessageIds,
    );
    return { readAt: now, updated: changes.changes };
  }

  public getInboxVersion(agentId: AgentId): Sequence {
    this.ensureOpen();
    const statement: Statement<unknown, [string, string]> = this.database.query(`
      SELECT COALESCE(MAX(sequence), 0) AS version
      FROM messages
      WHERE recipient_id = ? AND expires_at > ?
    `);
    const row: InboxVersionRow = InboxVersionRowSchema.parse(
      statement.get(agentId.value, this.clock.now().toISOString()),
    );
    return Sequence.parse(row.version);
  }

  public watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): InboxSubscription {
    this.ensureOpen();
    this.requireAgent(agentId);
    return new SqliteInboxSubscription(this, agentId, afterSequence, handler);
  }

  public pruneExpired(now: Instant): number {
    this.ensureOpen();
    const statement: Statement<unknown, [string]> = this.database.query(
      "DELETE FROM messages WHERE expires_at <= ?",
    );
    const changes: Changes = statement.run(now.toISOString());
    return changes.changes;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
