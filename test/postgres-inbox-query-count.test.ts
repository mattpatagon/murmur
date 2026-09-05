import { expect, spyOn, test } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { UnknownAgentError } from "../src/domain/errors.js";
import { AgentGeneration } from "../src/domain/lifecycle-values.js";
import type { GetMessagesQuery, MarkMessagesReadCommand } from "../src/domain/models.js";
import { AgentId, Instant, MessageId, Sequence, TenantId } from "../src/domain/value-objects.js";
import { HostedAuthenticator } from "../src/hosted/hosted-authenticator.js";
import {
  postgresLiveSessionCount,
  storedPostgresAgent,
} from "../src/storage/postgres-agent-lifecycle-rows.js";
import { postgresAgentInTransaction } from "../src/storage/postgres-agent-lifecycle-store.js";
import { PostgresInboxDispatcher } from "../src/storage/postgres-inbox-dispatcher.js";
import type { AgentRow } from "../src/storage/postgres-message-rows.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { requirePostgresAgents } from "../src/storage/postgres-message-transactions.js";

const NOW: Instant = Instant.parse("2026-09-05T00:00:00.000Z");
const AGENT: AgentId = AgentId.parse("inbox-query-reader");
const MESSAGE: MessageId = MessageId.generate();
const QUERY: GetMessagesQuery = {
  afterSequence: Sequence.zero(),
  agentId: AGENT,
  limit: 10,
  sessionKey: null,
  threadId: null,
  unreadOnly: false,
};
const ROW: AgentRow = {
  agent_id: AGENT.value,
  authority: "peer",
  closed_at: null,
  close_reason: null,
  created_at: NOW.toISOString(),
  display_name: "Inbox reader",
  generation: 1,
  last_seen_at: NOW.toISOString(),
  lease_expires_at: null,
  live_session_count: 0,
  metadata_json: "{}",
  state: "inactive",
};

class InboxFixture {
  public readonly database: Sql;
  public readonly tenant: TenantId = TenantId.generate();
  public readonly store: PostgresMessageStore;
  public readonly transactions: string[][] = [];
  public readonly events: string[] = [];
  public agent: AgentRow | null = ROW;
  public override: { readonly rows: unknown } | null = null;
  public failure: Error | null = null;

  public constructor() {
    const backing: Sql = postgres({ host: "127.0.0.1", max: 1, port: 1 });
    this.database = new Proxy(backing, {
      apply: (): Promise<unknown> =>
        Promise.resolve(this.override === null ? [] : this.override.rows),
    });
    Reflect.set(
      this.database,
      "begin",
      async (run: (query: unknown) => Promise<unknown>): Promise<unknown> => {
        const statements: string[] = [];
        this.transactions.push(statements);
        const query: (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) => Promise<unknown> = async (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ): Promise<unknown> => {
          const sql: string = strings.join("?");
          statements.push(sql);
          this.events.push(sql);
          expect(values).toContain(this.tenant.value);
          if (sql.includes("set_config")) return [];
          if (this.failure !== null) throw this.failure;
          if (sql.includes("AS candidates")) return [{ candidates: false }];
          if (this.override !== null) return this.override.rows;
          if (sql.includes("SELECT authority, generation")) {
            return this.agent === null
              ? []
              : [
                  {
                    authority: this.agent.authority,
                    closed_at: this.agent.closed_at,
                    close_reason: this.agent.close_reason,
                    generation: this.agent.generation,
                    metadata_json: this.agent.metadata_json,
                  },
                ];
          }
          if (sql.includes("session.live_session_count"))
            return this.agent === null ? [] : [this.agent];
          if (sql.includes("WITH candidates AS MATERIALIZED")) return [];
          if (sql.includes("SET read_at = COALESCE")) return [{ message_id: MESSAGE.value }];
          if (sql.includes("AS version")) return [{ version: 0 }];
          if (sql.includes("SELECT COUNT(*)::int AS count")) return [{ count: 0 }];
          if (sql.includes("SELECT agent_id, authority"))
            return [{ agent_id: AGENT.value, authority: "peer" }];
          throw new Error("Unexpected inbox fixture query");
        };
        return await run(query);
      },
    );
    const candidate: unknown = Reflect.construct(PostgresMessageStore, [
      this.database,
      {
        now: (): Instant => {
          this.events.push("clock");
          return NOW;
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
    if (!(candidate instanceof PostgresMessageStore)) throw new Error("Invalid inbox fixture");
    this.store = candidate;
  }
}

for (const operation of ["read", "mark", "empty mark"]) {
  test(`PostgreSQL ${operation} validates inside its own transaction without an outer lookup`, async (): Promise<void> => {
    const fixture: InboxFixture = new InboxFixture();
    const lookup: ReturnType<typeof spyOn<PostgresMessageStore, "getAgent">> = spyOn(
      fixture.store,
      "getAgent",
    );
    try {
      if (operation === "read") expect(await fixture.store.getMessages(QUERY)).toEqual([]);
      else {
        const command: MarkMessagesReadCommand = {
          agentId: AGENT,
          messageIds: operation === "mark" ? [MESSAGE] : [],
        };
        expect(await fixture.store.markMessagesRead(command)).toEqual({
          readAt: NOW,
          updated: operation === "mark" ? 1 : 0,
        });
      }
      expect(lookup).toHaveBeenCalledTimes(0);
      expect(fixture.transactions).toHaveLength(1);
      expect(fixture.events[0]).toBe("clock");
      expect(fixture.events.filter((event: string): boolean => event === "clock")).toHaveLength(1);
      expect(fixture.events[2]).toContain("AS candidates");
      const transaction: string[] | undefined = fixture.transactions[0];
      if (transaction === undefined) throw new Error("Missing inbox transaction");
      expect(transaction[0]).toContain("set_config");
      expect(transaction[1]).toContain("AS candidates");
      expect(transaction[2]).toContain("session.live_session_count");
      expect(transaction.length).toBe(operation === "empty mark" ? 3 : 4);
      expect(transaction.filter((sql: string): boolean => sql.includes("set_config"))).toHaveLength(
        1,
      );
    } finally {
      lookup.mockRestore();
      await fixture.store.close();
    }
  });
}

test("PostgreSQL inbox operations still reject missing or malformed current agents, including empty acknowledgements", async (): Promise<void> => {
  const fixture: InboxFixture = new InboxFixture();
  try {
    fixture.agent = null;
    await expect(fixture.store.getMessages(QUERY)).rejects.toBeInstanceOf(UnknownAgentError);
    await expect(
      fixture.store.markMessagesRead({ agentId: AGENT, messageIds: [] }),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    fixture.agent = { ...ROW, generation: 0 };
    await expect(fixture.store.getMessages(QUERY)).rejects.toThrow();
    await expect(
      fixture.store.markMessagesRead({ agentId: AGENT, messageIds: [MESSAGE] }),
    ).rejects.toThrow();
    expect(
      fixture.events.some((sql: string): boolean =>
        sql.includes("WITH candidates AS MATERIALIZED"),
      ),
    ).toBe(false);
    expect(
      fixture.events.some((sql: string): boolean => sql.includes("SET read_at = COALESCE")),
    ).toBe(false);
  } finally {
    await fixture.store.close();
  }
});

test("PostgreSQL inbox preflight failure prevents the subsequent agent or payload query", async (): Promise<void> => {
  const fixture: InboxFixture = new InboxFixture();
  fixture.failure = new Error("Preflight fixture failure");
  try {
    await expect(fixture.store.getMessages(QUERY)).rejects.toThrow();
    expect(fixture.transactions).toHaveLength(1);
    expect(
      fixture.events.some((sql: string): boolean => sql.includes("session.live_session_count")),
    ).toBe(false);
  } finally {
    await fixture.store.close();
  }
});

test("hot-path PostgreSQL row schemas are reused while validating every query result", async (): Promise<void> => {
  const fixture: InboxFixture = new InboxFixture();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(fixture.database);
  const arrays: ReturnType<typeof spyOn<typeof z, "array">> = spyOn(z, "array");
  const objects: ReturnType<typeof spyOn<typeof z, "strictObject">> = spyOn(z, "strictObject");
  try {
    for (let attempt: number = 0; attempt < 2; attempt += 1) {
      await fixture.database.begin(async (transaction: TransactionSql): Promise<void> => {
        expect(await storedPostgresAgent(transaction, fixture.tenant, AGENT)).toHaveProperty(
          "generation",
          1,
        );
        expect(
          await postgresAgentInTransaction(transaction, fixture.tenant, AGENT, NOW),
        ).toHaveProperty("generation.value", 1);
        expect(
          await postgresLiveSessionCount(
            transaction,
            fixture.tenant,
            AGENT,
            AgentGeneration.parse(1),
            NOW,
          ),
        ).toBe(0);
        await requirePostgresAgents(transaction, fixture.tenant, AGENT, AGENT, "peer");
      });
      expect(await authenticator.authenticate("schema-fixture-invalid-credential")).toBeNull();
    }
    expect(arrays).toHaveBeenCalledTimes(0);
    expect(objects).toHaveBeenCalledTimes(0);
    fixture.override = { rows: [{ unexpected: true }] };
    await fixture.database.begin(async (transaction: TransactionSql): Promise<void> => {
      await expect(storedPostgresAgent(transaction, fixture.tenant, AGENT)).rejects.toThrow();
      await expect(
        postgresAgentInTransaction(transaction, fixture.tenant, AGENT, NOW),
      ).rejects.toThrow();
      await expect(
        postgresLiveSessionCount(transaction, fixture.tenant, AGENT, AgentGeneration.parse(1), NOW),
      ).rejects.toThrow();
      await expect(
        requirePostgresAgents(transaction, fixture.tenant, AGENT, AGENT, "peer"),
      ).rejects.toThrow();
    });
    await expect(authenticator.authenticate("schema-fixture-invalid-credential")).rejects.toThrow();
  } finally {
    arrays.mockRestore();
    objects.mockRestore();
    await authenticator.close();
    await fixture.store.close();
  }
});
