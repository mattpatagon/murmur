import postgres, { type Sql } from "postgres";
import { AgentId, Instant, MessageId, Sequence, TenantId } from "../../src/domain/value-objects.js";
import type { DataToolContext } from "../../src/mcp/murmur-data-tools.js";
import { INBOX_PAGE_ROW_OVERHEAD_BYTES } from "../../src/storage/inbox-page-budget.js";
import { PostgresInboxDispatcher } from "../../src/storage/postgres-inbox-dispatcher.js";
import type { AgentRow, MessageRow } from "../../src/storage/postgres-message-rows.js";
import { PostgresMessageStore } from "../../src/storage/postgres-message-store.js";

export const READ_NOW: Instant = Instant.parse("2026-09-05T00:00:00.000Z");
export const READ_AGENT: AgentId = AgentId.parse("paired-inbox-reader");
export const READ_BYTES: number = INBOX_PAGE_ROW_OVERHEAD_BYTES + 13;
export type ReadStatement = { readonly text: string; readonly values: readonly unknown[] };

export type DeferredRead = { readonly promise: Promise<void>; readonly resolve: () => void };
export function deferred(): DeferredRead {
  let finish: () => void = (): void => {};
  const promise: Promise<void> = new Promise((resolve: () => void): void => {
    finish = resolve;
  });
  return { promise, resolve: (): void => finish() };
}

export class InboxReadFixture {
  public readonly tenant: TenantId = TenantId.generate();
  public readonly store: PostgresMessageStore;
  public readonly transactions: ReadStatement[][] = [];
  public clockCalls: number = 0;
  public completedTransactions: number = 0;
  public version: number = 17;
  public completionAction: (() => Promise<void>) | null = null;
  public pageAction: (() => Promise<void>) | null = null;
  public pageOverride: unknown[] | null = null;
  public snapshotOverride: unknown[] | null = null;
  public agent: AgentRow | null = {
    agent_id: READ_AGENT.value,
    authority: "peer",
    closed_at: null,
    close_reason: null,
    created_at: READ_NOW.toISOString(),
    display_name: "Inbox reader",
    generation: 1,
    last_seen_at: READ_NOW.toISOString(),
    lease_expires_at: null,
    live_session_count: 0,
    metadata_json: "{}",
    state: "inactive",
  };
  public row: MessageRow = {
    branch_name: null,
    broadcast_id: null,
    client_name: null,
    content: "x",
    created_at: READ_NOW.toISOString(),
    expires_at: READ_NOW.addDays(30).toISOString(),
    message_id: MessageId.generate().value,
    message_kind: "message",
    orchestrator_policy_id: null,
    read_at: null,
    recipient_id: READ_AGENT.value,
    recipient_generation: 1,
    repository_name: null,
    sender_id: "paired-inbox-sender",
    sender_generation: 1,
    sender_authority: "peer",
    sequence: 3,
    thread_id: "selected-thread",
  };

  public constructor() {
    const database: Sql = postgres({ host: "127.0.0.1", max: 1, port: 1 });
    Reflect.set(
      database,
      "begin",
      async (run: (query: unknown) => Promise<unknown>): Promise<unknown> => {
        const statements: ReadStatement[] = [];
        this.transactions.push(statements);
        const query: (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) => Promise<unknown> = async (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ): Promise<unknown> => {
          const text: string = strings.join("?");
          statements.push({ text, values });
          if (!values.includes(this.tenant.value))
            throw new Error("Inbox query lost tenant qualification");
          if (text.includes("set_config")) return [];
          if (text.includes("AS candidates")) return [{ candidates: false }];
          if (text.includes("session.live_session_count"))
            return this.agent === null ? [] : [this.agent];
          if (text.includes("WITH candidates AS MATERIALIZED")) {
            if (this.pageAction !== null) await this.pageAction();
            const rows: unknown[] =
              this.pageOverride === null
                ? [{ ...this.row, estimated_page_bytes: READ_BYTES }]
                : this.pageOverride;
            if (!text.includes("AS inbox_version")) return rows;
            if (this.snapshotOverride !== null) return this.snapshotOverride;
            if (rows.length === 0) return [this.emptySnapshot()];
            return rows.map((row: unknown): unknown =>
              typeof row === "object" && row !== null
                ? { ...row, inbox_version: this.version }
                : row,
            );
          }
          if (text.includes("AS version")) {
            return [{ version: this.version }];
          }
          throw new Error("Unexpected inbox-read fixture query");
        };
        const result: unknown = await run(query);
        if (
          this.completionAction !== null &&
          statements.some((statement: ReadStatement): boolean =>
            statement.text.includes("WITH candidates AS MATERIALIZED"),
          )
        )
          await this.completionAction();
        this.completedTransactions += 1;
        return result;
      },
    );
    const candidate: unknown = Reflect.construct(PostgresMessageStore, [
      database,
      {
        now: (): Instant => {
          this.clockCalls += 1;
          return READ_NOW;
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
    if (!(candidate instanceof PostgresMessageStore)) throw new Error("Invalid inbox read fixture");
    this.store = candidate;
  }

  public context(): DataToolContext {
    return {
      boundAgentId: null,
      branchName: null,
      client: null,
      legacyMessageShape: false,
      notifyResourceListChanged: async (): Promise<void> => {},
      recordRepositoryDivergence: (): void => {},
      repositoryName: null,
      senderAuthority: "peer",
      store: this.store,
    };
  }

  public statements(): ReadStatement[] {
    return this.transactions.flat();
  }

  public emptySnapshot(): Record<string, unknown> {
    const payload: Record<string, null> = Object.fromEntries(
      Object.keys(this.row).map((key: string): [string, null] => [key, null]),
    );
    return { ...payload, estimated_page_bytes: 0, inbox_version: this.version };
  }
}
