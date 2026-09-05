import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, type Mock, spyOn, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { type InboxOutput, InboxOutputSchema, type MessageDto } from "../src/domain/contracts.js";
import {
  type HistoryMessageDto,
  type MessageHistoryOutput,
  MessageHistoryOutputSchema,
} from "../src/domain/history-contracts.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import {
  AgentId,
  DisplayName,
  IdempotencyKey,
  Instant,
  ThreadId,
} from "../src/domain/value-objects.js";
import { callDataTool, type DataToolContext } from "../src/mcp/murmur-data-tools.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { baseMessageCommand } from "./support/store-fixture.js";

const NOW: Instant = Instant.parse("2026-09-05T00:00:00.000Z");
const READER: AgentId = AgentId.parse("bob");
const SESSION: SessionKey = SessionKey.parse("paired-pane");
type Fixture = {
  readonly store: SqliteMessageStore;
  readonly database: Database;
  readonly context: DataToolContext;
  readonly calls: () => number;
  readonly reset: (now: Instant) => void;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  let current: Instant = NOW;
  let clockCalls: number = 0;
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", {
    now: (): Instant => {
      clockCalls += 1;
      return current;
    },
  });
  const database: unknown = Reflect.get(store, "database");
  if (!(database instanceof Database)) throw new Error("Missing SQLite fixture database");
  const context: DataToolContext = {
    boundAgentId: null,
    branchName: null,
    client: null,
    legacyMessageShape: false,
    notifyResourceListChanged: async (): Promise<void> => {},
    recordRepositoryDivergence: (): void => {},
    repositoryName: null,
    senderAuthority: "peer",
    store,
  };
  try {
    for (const id of ["alice", "bob"])
      store.registerAgent({
        agentId: AgentId.parse(id),
        displayName: DisplayName.parse(id),
        metadata: {},
      });
    store.registerAgent({
      agentId: READER,
      displayName: DisplayName.parse("Reader"),
      metadata: {},
      sessionKey: SESSION,
    });
    await run({
      store,
      database,
      context,
      calls: (): number => clockCalls,
      reset: (now: Instant): void => {
        current = now;
        clockCalls = 0;
      },
    });
  } finally {
    store.close();
  }
}

async function read(fixture: Fixture, input: object): Promise<InboxOutput> {
  const result: CallToolResult | null = await callDataTool(
    "get_messages",
    { agent_id: READER.value, ...input },
    fixture.context,
  );
  if (result === null) throw new Error("Missing inbox result");
  return InboxOutputSchema.parse(result.structuredContent);
}

test("SQLite paired inbox reads keep unfiltered version and renew named sessions within one captured instant", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    for (let index: number = 0; index < 4; index += 1)
      fixture.store.sendMessage({
        ...baseMessageCommand(),
        idempotencyKey: IdempotencyKey.parse(`paired-${index}`),
        threadId: ThreadId.parse(index % 2 === 0 ? "selected" : "other"),
      });
    fixture.reset(NOW.addMinutes(5));
    const output: InboxOutput = await read(fixture, {
      after_sequence: 1,
      thread_id: "selected",
      unread_only: true,
      limit: 1,
      session_key: SESSION.value,
    });
    expect(output.messages.map((message: MessageDto): number => message.sequence)).toEqual([3]);
    expect(output.inbox_version).toBe(4);
    expect(fixture.calls()).toBe(1);
    expect(
      fixture.database
        .query(
          "SELECT last_renewed_at, lease_expires_at FROM agent_sessions WHERE agent_id = ? AND session_key = ?",
        )
        .get(READER.value, SESSION.value),
    ).toEqual({
      last_renewed_at: NOW.addMinutes(5).toISOString(),
      lease_expires_at: NOW.addMinutes(65).toISOString(),
    });
    expect(
      fixture.database
        .query(
          "SELECT last_renewed_at FROM agent_sessions WHERE agent_id = ? AND session_key = 'default'",
        )
        .get(READER.value),
    ).toEqual({ last_renewed_at: NOW.toISOString() });
    await read(fixture, { session_key: "never-created" });
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM agent_sessions WHERE session_key = 'never-created'")
        .get(),
    ).toEqual({ count: 0n });
  });
});

test("SQLite paired history uses its explicit generation after reopen and expires both page and version at the exact boundary", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    fixture.store.sendMessage(baseMessageCommand());
    fixture.store.closeAgent({
      agentId: READER,
      closeReason: "completed",
      expectedGeneration: AgentGeneration.parse(1),
    });
    fixture.store.registerAgent({
      agentId: READER,
      displayName: DisplayName.parse("Reopened"),
      metadata: {},
    });
    fixture.store.sendMessage({
      ...baseMessageCommand(),
      idempotencyKey: IdempotencyKey.parse("paired-new-generation"),
    });
    fixture.reset(NOW);
    const result: CallToolResult | null = await callDataTool(
      "get_message_history",
      { agent_id: READER.value, generation: 1 },
      fixture.context,
    );
    if (result === null) throw new Error("Missing history result");
    const history: MessageHistoryOutput = MessageHistoryOutputSchema.parse(
      result.structuredContent,
    );
    expect(
      history.messages.map((message: HistoryMessageDto): number => message.recipient_generation),
    ).toEqual([1]);
    expect(history.inbox_version).toBe(1);
    expect(fixture.calls()).toBe(1);
    expect((await read(fixture, {})).inbox_version).toBe(2);
    fixture.reset(NOW.addDays(30));
    const empty: InboxOutput = await read(fixture, {});
    expect(empty.messages).toEqual([]);
    expect(empty.inbox_version).toBe(0);
    expect(fixture.calls()).toBe(1);
  });
});

test("SQLite version-query failure rolls back a named renewal and leaves the paired read retryable", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    fixture.store.sendMessage(baseMessageCommand());
    fixture.reset(NOW.addMinutes(5));
    const query: Database["query"] = fixture.database.query.bind(fixture.database);
    const lease: (session: SessionKey) => unknown = (session: SessionKey): unknown =>
      query(
        "SELECT last_renewed_at, lease_expires_at FROM agent_sessions WHERE agent_id = ? AND session_key = ?",
      ).get(READER.value, session.value);
    const originalLease: unknown = lease(SESSION);
    const defaultLease: unknown = lease(SessionKey.default());
    const queries: Mock<Database["query"]> = spyOn(fixture.database, "query");
    let pageReads: number = 0;
    let versionReads: number = 0;
    queries.mockImplementation(function failVersionQuery<
      Result,
      Bindings extends SQLQueryBindings | SQLQueryBindings[],
    >(sql: string): ReturnType<typeof query<Result, Bindings>> {
      if (sql.includes("SELECT * FROM messages")) pageReads += 1;
      if (sql.includes("SELECT COALESCE(MAX(sequence), 0) AS version")) {
        versionReads += 1;
        expect(fixture.database.inTransaction).toBe(true);
        expect(pageReads).toBe(1);
        expect(lease(SESSION)).toEqual({
          last_renewed_at: NOW.addMinutes(5).toISOString(),
          lease_expires_at: NOW.addMinutes(65).toISOString(),
        });
        throw new Error("Injected inbox-version failure");
      }
      return query<Result, Bindings>(sql);
    });
    try {
      await expect(read(fixture, { session_key: SESSION.value })).rejects.toThrow(
        "Injected inbox-version failure",
      );
      expect(versionReads).toBe(1);
      expect(fixture.calls()).toBe(1);
      expect(fixture.database.inTransaction).toBe(false);
      expect(lease(SESSION)).toEqual(originalLease);
      expect(lease(SessionKey.default())).toEqual(defaultLease);
    } finally {
      queries.mockRestore();
    }
    fixture.reset(NOW.addMinutes(5));
    const retried: InboxOutput = await read(fixture, { session_key: SESSION.value });
    expect(retried.messages.map((message: MessageDto): number => message.sequence)).toEqual([1]);
    expect(retried.inbox_version).toBe(1);
    expect(fixture.calls()).toBe(1);
    expect(fixture.database.inTransaction).toBe(false);
    expect(lease(SESSION)).toEqual({
      last_renewed_at: NOW.addMinutes(5).toISOString(),
      lease_expires_at: NOW.addMinutes(65).toISOString(),
    });
    expect(lease(SessionKey.default())).toEqual(defaultLease);
  });
});
