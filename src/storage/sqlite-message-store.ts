import { type Changes, Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { IdempotencyConflictError, UnknownAgentError } from "../domain/errors.js";
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
  type AgentId,
  type Clock,
  type Instant,
  MessageId,
  Sequence,
  SystemClock,
  TenantId,
  ThreadId,
} from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type { InboxSubscription, InboxUpdateHandler, MessageStore } from "./message-store.js";
import { broadcastSqliteMessage } from "./sqlite-broadcast-store.js";
import { migrateSqliteDatabase } from "./sqlite-message-migrations.js";
import {
  type InboxVersionRow,
  InboxVersionRowSchema,
  mapAgentRow,
  mapMessageRow,
} from "./sqlite-message-rows.js";

const SQLITE_WATCH_INTERVAL_MS: number = 200;
type IntervalHandle = ReturnType<typeof setInterval>;

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
      logSafeError("Murmur SQLite inbox watcher error", error);
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
    migrateSqliteDatabase(this.database);
    this.pruneExpired(this.clock.now());
  }

  public scope(tenantId: TenantId): MessageStore {
    if (!tenantId.equals(TenantId.founding())) {
      throw new Error("SQLite storage supports only the founding tenant");
    }
    return this;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The message store is closed");
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

  public broadcastMessage(command: BroadcastMessageCommand): BroadcastMessageResult {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    this.requireAgent(command.senderId);
    return broadcastSqliteMessage(this.database, command, now);
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
    const broadcastStatement: Statement<unknown, [string]> = this.database.query(
      "DELETE FROM broadcasts WHERE expires_at <= ?",
    );
    broadcastStatement.run(now.toISOString());
    return changes.changes;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
