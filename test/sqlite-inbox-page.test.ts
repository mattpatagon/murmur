import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { MAX_INBOX_PAGE_BYTES } from "../src/storage/inbox-page-budget.js";
import {
  readSqliteInboxPage,
  type SqliteInboxPageQuery,
} from "../src/storage/sqlite-inbox-page.js";
import { PAGE_ERROR, PAGE_TEST_NOW } from "./support/inbox-page-fixture.js";

type BunParameterList = Parameters<Statement["all"]>;
type QueryParameters<ParamsType> = ParamsType extends BunParameterList ? ParamsType : [ParamsType];

class ObservedDatabase extends Database {
  public payloadQueries: number = 0;
  public onPayloadQuery: (() => void) | null = null;

  public override query<ReturnType, ParamsType extends SQLQueryBindings | SQLQueryBindings[]>(
    sql: string,
  ): Statement<ReturnType, QueryParameters<ParamsType>> {
    if (sql.startsWith("SELECT * FROM ") || sql.startsWith("SELECT sequence, envelope_json,")) {
      this.payloadQueries += 1;
      if (this.onPayloadQuery !== null) this.onPayloadQuery();
    }
    return super.query<ReturnType, ParamsType>(sql);
  }
}

function database(filename: string = ":memory:"): ObservedDatabase {
  const result: ObservedDatabase = new ObservedDatabase(filename, { safeIntegers: true });
  result.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY, recipient_id TEXT, recipient_generation INTEGER,
      expires_at TEXT, read_at TEXT, thread_id TEXT, content TEXT
    );
    CREATE TABLE e2ee_messages (
      sequence INTEGER PRIMARY KEY, recipient_id TEXT, recipient_generation INTEGER,
      expires_at TEXT, read_at TEXT, thread_id TEXT, envelope_json TEXT, sender_chain_json TEXT
    );
  `);
  return result;
}

function query(): SqliteInboxPageQuery {
  return {
    afterSequence: 0,
    agentId: "bob",
    expiresAfter: PAGE_TEST_NOW,
    generation: 1,
    limit: 500,
    threadId: null,
    unreadOnly: false,
  };
}

function insert(databaseValue: Database, sequence: number, content: string): void {
  databaseValue
    .query<unknown, [number, string]>(`
      INSERT INTO messages VALUES (?, 'bob', 1, '2030-01-31T00:00:00.000Z', NULL, 'one', ?)
    `)
    .run(sequence, content);
}

function sequences(rows: unknown[]): number[] {
  return z
    .array(z.object({ sequence: z.bigint().transform(Number) }))
    .parse(rows)
    .map((row: { readonly sequence: number }): number => row.sequence);
}

test("SQLite does not even prepare the payload SELECT for an oversized candidate page", (): void => {
  const connection: ObservedDatabase = database();
  try {
    for (let index: number = 1; index <= 7; index += 1)
      insert(connection, index, "x".repeat(100_000));
    expect((): void => {
      readSqliteInboxPage(connection, "plaintext", query());
    }).toThrow(PAGE_ERROR);
    expect(connection.payloadQueries).toBe(0);
    expect(
      sequences(readSqliteInboxPage(connection, "plaintext", { ...query(), limit: 1 })),
    ).toEqual([1]);
    expect(connection.payloadQueries).toBe(1);
  } finally {
    connection.close();
  }
});

test("SQLite byte preflight applies every page filter and the requested ordering and limit", (): void => {
  const connection: ObservedDatabase = database();
  try {
    for (let index: number = 1; index <= 9; index += 1)
      insert(connection, index, "x".repeat(100_000));
    connection.exec(`
      UPDATE messages SET recipient_id = 'other' WHERE sequence = 1;
      UPDATE messages SET recipient_generation = 2 WHERE sequence = 2;
      UPDATE messages SET expires_at = '2030-01-01T00:00:00.000Z' WHERE sequence = 3;
      UPDATE messages SET read_at = '2030-01-01T00:00:00.000Z' WHERE sequence = 4;
      UPDATE messages SET thread_id = 'two' WHERE sequence = 5;
    `);
    expect(
      sequences(
        readSqliteInboxPage(connection, "plaintext", {
          ...query(),
          threadId: "one",
          unreadOnly: true,
        }),
      ),
    ).toEqual([6, 7, 8, 9]);
    const filtered: SqliteInboxPageQuery = {
      ...query(),
      afterSequence: 6,
      threadId: "one",
      unreadOnly: true,
    };
    expect(sequences(readSqliteInboxPage(connection, "plaintext", filtered))).toEqual([7, 8, 9]);
    expect(
      sequences(readSqliteInboxPage(connection, "plaintext", { ...filtered, limit: 2 })),
    ).toEqual([7, 8]);
    expect(readSqliteInboxPage(connection, "plaintext", { ...filtered, afterSequence: 9 })).toEqual(
      [],
    );
    expect(
      sequences(readSqliteInboxPage(connection, "plaintext", { ...query(), generation: 2 })),
    ).toEqual([2]);
    expect(
      sequences(readSqliteInboxPage(connection, "plaintext", { ...query(), threadId: "two" })),
    ).toEqual([5]);
    connection.exec(`INSERT INTO e2ee_messages SELECT
      sequence, recipient_id, recipient_generation, expires_at, read_at, thread_id, content, '{}'
      FROM messages`);
    expect(sequences(readSqliteInboxPage(connection, "encrypted", filtered))).toEqual([7, 8, 9]);
  } finally {
    connection.close();
  }
});

test("SQLite accepts an exact estimated-byte boundary and rejects the next UTF-8 byte", (): void => {
  const connection: ObservedDatabase = database();
  try {
    // Eighteen row allowances leave an exact multiple, with each content below 100,000 characters.
    const contentBytes: number = (MAX_INBOX_PAGE_BYTES - 18 * 16_384) / 13;
    for (let sequence: number = 1; sequence <= 17; sequence += 1) {
      insert(connection, sequence, "x".repeat(31_000));
    }
    insert(connection, 18, "x".repeat(contentBytes - 17 * 31_000));
    expect(sequences(readSqliteInboxPage(connection, "plaintext", query()))).toHaveLength(18);
    connection.exec("UPDATE messages SET content = content || 'x' WHERE sequence = 18");
    const previousQueries: number = connection.payloadQueries;
    expect((): void => {
      readSqliteInboxPage(connection, "plaintext", query());
    }).toThrow(PAGE_ERROR);
    expect(connection.payloadQueries).toBe(previousQueries);
  } finally {
    connection.close();
  }
});

test("an oversized legacy encrypted row is rejected before payload selection or JSON decoding", (): void => {
  const connection: ObservedDatabase = database();
  try {
    connection
      .query<unknown, [string]>(`
      INSERT INTO e2ee_messages VALUES (
        1, 'bob', 1, '2030-01-31T00:00:00.000Z', NULL, 'one', '{}', ?
      )
    `)
      .run(JSON.stringify({ legacy: "x".repeat(3 * 1024 * 1024) }));
    expect((): void => {
      readSqliteInboxPage(connection, "encrypted", { ...query(), limit: 1 });
    }).toThrow(PAGE_ERROR);
    expect(connection.payloadQueries).toBe(0);
  } finally {
    connection.close();
  }
});

test("a writer between SQLite preflight and payload selection cannot change the read snapshot", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-page-snapshot-"));
  const filename: string = join(directory, "messages.db");
  const reader: ObservedDatabase = database(filename);
  const writer: Database = new Database(filename);
  try {
    for (let index: number = 1; index <= 7; index += 1) insert(reader, index, "small");
    reader.onPayloadQuery = (): void => {
      reader.onPayloadQuery = null;
      writer.query<unknown, [string]>("UPDATE messages SET content = ?").run("x".repeat(100_000));
    };
    const rows: { readonly content: string }[] = z
      .array(z.object({ content: z.string() }))
      .parse(readSqliteInboxPage(reader, "plaintext", query()));
    expect(rows.map((row: { readonly content: string }): string => row.content)).toEqual(
      Array.from({ length: 7 }, (): string => "small"),
    );
    expect((): void => {
      readSqliteInboxPage(reader, "plaintext", query());
    }).toThrow(PAGE_ERROR);
  } finally {
    writer.close();
    reader.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("empty, failed and nonempty SQLite reads settle hosted byte reservations correctly", (): void => {
  const connection: ObservedDatabase = database();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const finishHandler: () => void = scope.startHandler();
  try {
    withMaterializationScope(scope, (): void => {
      for (let index: number = 0; index < 100; index += 1) {
        expect(readSqliteInboxPage(connection, "plaintext", query())).toEqual([]);
        expect(budget.reservedBytes).toBe(0);
      }
      insert(connection, 1, "hi");
      readSqliteInboxPage(connection, "plaintext", query());
      expect(budget.reservedBytes).toBe(16_384 + 2 * 13);
    });
    finishHandler();
    expect(budget.reservedBytes).toBeGreaterThan(0);
    scope.finishResponse();
    expect(budget.reservedBytes).toBe(0);
    const failedScope: MaterializationScope = new MaterializationScope(budget);
    withMaterializationScope(failedScope, (): void => {
      connection.exec("DROP TABLE messages");
      expect((): void => {
        readSqliteInboxPage(connection, "plaintext", query());
      }).toThrow();
      expect(budget.reservedBytes).toBe(0);
    });
    failedScope.finishResponse();
  } finally {
    finishHandler();
    scope.finishResponse();
    connection.close();
  }
});
