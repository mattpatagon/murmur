import { type Changes, Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  Notice,
  PostNoticeCommand,
  PostNoticeResult,
  ResolveNoticeCommand,
  ResolveNoticeResult,
  WithdrawNoticeCommand,
  WithdrawNoticeResult,
} from "../domain/notice-models.js";
import {
  type AgentId,
  type Clock,
  type Instant,
  type MessageId,
  Sequence,
  SystemClock,
  TenantId,
} from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type { InboxSubscription, InboxUpdateHandler, MessageStore } from "./message-store.js";
import { broadcastSqliteMessage } from "./sqlite-broadcast-store.js";
import { sendSqliteMessage } from "./sqlite-direct-message-store.js";
import {
  closeSqliteAgent,
  endSqliteSession,
  listSqliteAgents,
  registerSqliteAgent,
  renewSqliteSession,
  sqliteAgent,
} from "./sqlite-agent-lifecycle-store.js";
import { migrateSqliteDatabase } from "./sqlite-message-migrations.js";
import { pruneSqliteLifecycle } from "./sqlite-lifecycle-prune.js";
import {
  type InboxVersionRow,
  InboxVersionRowSchema,
  mapMessageRow,
} from "./sqlite-message-rows.js";
import {
  listSqliteNotices,
  postSqliteNotice,
  pruneSqliteNotices,
  resolveSqliteNotice,
  withdrawSqliteNotice,
} from "./sqlite-notice-store.js";

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
    // Lock waiting must precede WAL conversion so concurrent startup retries instead of failing.
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
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

  public registerAgent(command: RegisterAgentCommand): RegisterAgentResult {
    this.ensureOpen();
    return registerSqliteAgent(this.database, command, this.clock.now());
  }

  public getAgent(agentId: AgentId): Agent | null {
    this.ensureOpen();
    const known: unknown = this.database
      .query<unknown, [string]>("SELECT 1 AS present FROM agents WHERE agent_id = ?")
      .get(agentId.value);
    return known === null ? null : sqliteAgent(this.database, agentId, this.clock.now());
  }

  public listAgents(query: ListAgentsQuery): readonly Agent[] {
    this.ensureOpen();
    this.pruneExpired(this.clock.now());
    return listSqliteAgents(this.database, query, this.clock.now());
  }

  public endSession(command: EndSessionCommand): EndSessionResult {
    this.ensureOpen();
    return endSqliteSession(this.database, command, this.clock.now());
  }

  public closeAgent(command: CloseAgentCommand): CloseAgentResult {
    this.ensureOpen();
    return closeSqliteAgent(this.database, command, this.clock.now());
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
    return sendSqliteMessage(this.database, command, now);
  }

  public getMessages(query: GetMessagesQuery): readonly Message[] {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    let agent: Agent = this.requireAgent(query.agentId);
    if (query.sessionKey != null) {
      agent = renewSqliteSession(this.database, query.agentId, query.sessionKey, now, false);
    }
    const generation: number =
      query.generation == null ? agent.generation.value : query.generation.value;
    const unreadFlag: number = query.unreadOnly ? 1 : 0;
    const threadId: string | null = query.threadId === null ? null : query.threadId.value;
    const statement: Statement<
      unknown,
      [string, number, number, string, number, string | null, string | null, number]
    > = this.database.query(`
      SELECT * FROM messages
      WHERE recipient_id = ?
        AND recipient_generation = ?
        AND sequence > ?
        AND expires_at > ?
        AND (? = 0 OR read_at IS NULL)
        AND (? IS NULL OR thread_id = ?)
      ORDER BY sequence ASC
      LIMIT ?
    `);
    const rows: unknown[] = statement.all(
      query.agentId.value,
      generation,
      query.afterSequence.value,
      now.toISOString(),
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
    let agent: Agent = this.requireAgent(command.agentId);
    if (command.sessionKey != null) {
      agent = renewSqliteSession(this.database, command.agentId, command.sessionKey, now, false);
    }
    const generation: number =
      command.generation == null ? agent.generation.value : command.generation.value;
    if (command.messageIds.length === 0) return { readAt: now, updated: 0 };

    const serializedMessageIds: string = JSON.stringify(
      command.messageIds.map((messageId: MessageId): string => messageId.value),
    );
    const updateStatement: Statement<unknown, [string, string, number, string, string]> =
      this.database.query(`
      UPDATE messages
      SET read_at = COALESCE(read_at, ?)
      WHERE recipient_id = ?
        AND recipient_generation = ?
        AND message_id IN (SELECT value FROM json_each(?))
        AND expires_at > ?
    `);
    const changes: Changes = updateStatement.run(
      now.toISOString(),
      command.agentId.value,
      generation,
      serializedMessageIds,
      now.toISOString(),
    );
    return { readAt: now, updated: changes.changes };
  }

  public postNotice(command: PostNoticeCommand): PostNoticeResult {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    return postSqliteNotice(this.database, command, now);
  }

  public listNotices(query: ListNoticesQuery): readonly Notice[] {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    return listSqliteNotices(this.database, query, now);
  }

  public resolveNotice(command: ResolveNoticeCommand): ResolveNoticeResult {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    return resolveSqliteNotice(this.database, command, now);
  }

  public withdrawNotice(command: WithdrawNoticeCommand): WithdrawNoticeResult {
    this.ensureOpen();
    const now: Instant = this.clock.now();
    this.pruneExpired(now);
    return withdrawSqliteNotice(this.database, command, now);
  }

  public getInboxVersion(
    agentId: AgentId,
    generation: import("../domain/lifecycle-values.js").AgentGeneration | null = null,
  ): Sequence {
    this.ensureOpen();
    const agent: Agent = this.requireAgent(agentId);
    const statement: Statement<unknown, [string, number, string]> = this.database.query(`
      SELECT COALESCE(MAX(sequence), 0) AS version
      FROM messages
      WHERE recipient_id = ? AND recipient_generation = ? AND expires_at > ?
    `);
    const row: InboxVersionRow = InboxVersionRowSchema.parse(
      statement.get(
        agentId.value,
        generation === null ? agent.generation.value : generation.value,
        this.clock.now().toISOString(),
      ),
    );
    return Sequence.parse(row.version);
  }

  public watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): InboxSubscription {
    this.ensureOpen();
    const agent: Agent = this.requireAgent(agentId);
    if (agent.state === "closed") throw new AgentClosedError(agentId.value);
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
    pruneSqliteNotices(this.database, now);
    pruneSqliteLifecycle(this.database, now);
    return changes.changes;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
