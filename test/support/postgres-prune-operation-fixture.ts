import postgres, { type Sql } from "postgres";
import { AgentId, Instant, MessageId, Sequence, TenantId } from "../../src/domain/value-objects.js";
import { PostgresInboxDispatcher } from "../../src/storage/postgres-inbox-dispatcher.js";
import type { AgentRow } from "../../src/storage/postgres-message-rows.js";
import { PostgresMessageStore } from "../../src/storage/postgres-message-store.js";

export const PRUNE_NOW: Instant = Instant.parse("2026-09-05T00:00:00.000Z");
export const PRUNE_AGENT: AgentId = AgentId.parse("prune-operation-reader");
export const PRUNE_MESSAGE: MessageId = MessageId.generate();
export const PRUNE_PRIVATE_ERROR: string = "private database diagnostic";
export type PruneFailureStage =
  | "begin"
  | "context"
  | "candidate"
  | "preflight-commit"
  | "operation-commit"
  | "message-prune"
  | "notice-prune"
  | "agent"
  | "page"
  | "version"
  | "ack";
export type PruneTransaction = {
  readonly statements: string[];
  readonly events: string[];
  status: "active" | "committed" | "rolled-back";
};

export class PruneDatabaseFailure extends Error {
  public readonly code: string = "XX000";

  public constructor() {
    super(PRUNE_PRIVATE_ERROR);
  }
}

// This driver models transaction commit/rollback, not the proposed transaction runner.
// Every operation still enters through the real public store and existing SQL adapters.
export class PostgresPruneFixture {
  public readonly tenant: TenantId = TenantId.generate();
  public readonly database: Sql;
  public readonly store: PostgresMessageStore;
  public readonly transactions: PruneTransaction[] = [];
  public readonly events: string[] = [];
  public readonly candidateTimes: string[] = [];
  public now: Instant = PRUNE_NOW;
  public clockCalls: number = 0;
  public contextCalls: number = 0;
  public failureContextOrdinal: number = 1;
  public expiredMessages: number = 0;
  public acknowledged: number = 0;
  public retainedCandidate: boolean = false;
  public agentAvailable: boolean = true;
  public failAt: PruneFailureStage | null = null;
  public readonly failure: PruneDatabaseFailure = new PruneDatabaseFailure();
  public candidateRows: { readonly value: unknown } | null = null;
  private active: boolean = false;

  public constructor() {
    const backing: Sql = postgres({ host: "127.0.0.1", port: 1, max: 1 });
    this.database = new Proxy(backing, {
      apply: (): never => {
        throw new Error("Unscoped database query refused");
      },
    });
    Reflect.set(
      this.database,
      "begin",
      async (run: (query: unknown) => Promise<unknown>): Promise<unknown> => {
        if (this.active) throw new Error("Nested operation transaction refused");
        this.active = true;
        const transaction: PruneTransaction = { statements: [], events: [], status: "active" };
        this.transactions.push(transaction);
        this.events.push("begin");
        const previousMessages: number = this.expiredMessages;
        const previousAcknowledged: number = this.acknowledged;
        let tenantSet: boolean = false;
        const query: (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) => Promise<unknown> = async (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ): Promise<unknown> => {
          const sql: string = strings.join("?");
          transaction.statements.push(sql);
          if (!values.includes(this.tenant.value)) throw new Error("Unqualified fixture query");
          if (sql.includes("set_config")) {
            if (tenantSet) throw new Error("Duplicate tenant context refused");
            this.record(transaction, "context");
            this.contextCalls += 1;
            if (this.contextCalls === this.failureContextOrdinal) this.fail("context");
            tenantSet = true;
            return [];
          }
          if (!tenantSet) throw new Error("Missing transaction tenant context");
          return this.query(transaction, sql, values);
        };
        try {
          this.fail("begin");
          const result: unknown = await run(query);
          if (transaction.events.includes("agent")) this.fail("operation-commit");
          else if (transaction.events.includes("candidate")) this.fail("preflight-commit");
          transaction.status = "committed";
          this.events.push("commit");
          return result;
        } catch (error: unknown) {
          this.expiredMessages = previousMessages;
          this.acknowledged = previousAcknowledged;
          transaction.status = "rolled-back";
          this.events.push("rollback");
          throw error;
        } finally {
          this.active = false;
        }
      },
    );
    const candidate: unknown = Reflect.construct(PostgresMessageStore, [
      this.database,
      {
        now: (): Instant => {
          this.clockCalls += 1;
          return this.now;
        },
      },
      this.tenant,
      {
        closed: false,
        closePromise: null,
        dispatcher: new PostgresInboxDispatcher({
          readVersion: async (): Promise<Sequence> => Sequence.zero(),
          reportError: (): void => {},
        }),
        listener: null,
      },
      true,
    ]);
    if (!(candidate instanceof PostgresMessageStore)) throw new Error("Invalid prune fixture");
    this.store = candidate;
  }

  private record(transaction: PruneTransaction, event: string): void {
    transaction.events.push(event);
    this.events.push(event);
  }

  private fail(stage: PruneFailureStage): void {
    if (this.failAt === stage) throw this.failure;
  }

  private query(transaction: PruneTransaction, sql: string, values: readonly unknown[]): unknown {
    if (sql.includes("AS candidates")) {
      this.record(transaction, "candidate");
      this.fail("candidate");
      const timestamp: unknown = values[1];
      if (typeof timestamp !== "string") throw new Error("Missing prune timestamp");
      this.candidateTimes.push(timestamp);
      if (this.candidateRows !== null) return this.candidateRows.value;
      return [
        {
          candidates:
            this.retainedCandidate ||
            (this.expiredMessages > 0 &&
              Instant.parse(timestamp).toEpochMilliseconds() >= PRUNE_NOW.toEpochMilliseconds()),
        },
      ];
    }
    if (sql.includes("DELETE FROM murmur.messages AS message USING expired")) {
      this.record(transaction, "message-prune");
      this.fail("message-prune");
      const count: number = Math.min(this.expiredMessages, 1000);
      this.expiredMessages -= count;
      return [{ count }];
    }
    if (sql.includes("DELETE FROM murmur.broadcasts AS broadcast")) {
      this.record(transaction, "broadcast-prune");
      return [];
    }
    if (sql.includes("DELETE FROM murmur.notices")) {
      this.record(transaction, "notice-prune");
      this.fail("notice-prune");
      return [{ count: 0 }];
    }
    if (sql.includes("SELECT agent.agent_id FROM murmur.agents AS agent")) {
      this.record(transaction, "lifecycle-candidates");
      return [];
    }
    if (
      sql.includes("SELECT COUNT(*)::int AS count FROM updated") ||
      sql.includes("SELECT COUNT(*)::int AS count FROM deleted")
    ) {
      this.record(transaction, "lifecycle-prune");
      return [{ count: 0 }];
    }
    if (sql.includes("session.live_session_count")) {
      this.record(transaction, "agent");
      this.fail("agent");
      return this.agentAvailable ? [this.agent()] : [];
    }
    if (sql.includes("SELECT agent_id, authority")) {
      this.record(transaction, "agent");
      this.fail("agent");
      return this.agentAvailable ? [{ agent_id: PRUNE_AGENT.value, authority: "peer" }] : [];
    }
    if (sql.includes("WITH candidates AS MATERIALIZED")) {
      this.record(transaction, "page");
      this.fail("page");
      return [];
    }
    if (sql.includes("AS version")) {
      this.record(transaction, "version");
      this.fail("version");
      return [{ version: 0 }];
    }
    if (sql.includes("SET read_at = COALESCE")) {
      this.record(transaction, "ack");
      this.acknowledged += 1;
      this.fail("ack");
      return [{ message_id: PRUNE_MESSAGE.value }];
    }
    throw new Error("Unexpected prune fixture query");
  }

  private agent(): AgentRow {
    return {
      agent_id: PRUNE_AGENT.value,
      authority: "peer",
      closed_at: null,
      close_reason: null,
      created_at: PRUNE_NOW.toISOString(),
      display_name: "Prune reader",
      generation: 1,
      last_seen_at: PRUNE_NOW.toISOString(),
      lease_expires_at: null,
      live_session_count: 0,
      metadata_json: "{}",
      state: "inactive",
    };
  }
}
