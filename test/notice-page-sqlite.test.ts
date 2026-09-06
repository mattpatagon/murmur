import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoticeId } from "../src/domain/lifecycle-values.js";
import type { ListNoticesQuery, ListNoticesResult, Notice } from "../src/domain/notice-models.js";
import { BranchName, Instant, RepositoryName } from "../src/domain/value-objects.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { MAX_NOTICE_PAGE_BYTES, NOTICE_PAGE_ROW_BYTES } from "../src/storage/notice-page-budget.js";
import { readSqliteNoticePage } from "../src/storage/sqlite-notice-page.js";
import { NOTICE_PAGE_NOW, noticePageQuery, noticePageRow } from "./support/notice-page-rows.js";

type BunParameterList = Parameters<Statement["all"]>;
type QueryParameters<ParamsType> = ParamsType extends BunParameterList ? ParamsType : [ParamsType];

class ObservedDatabase extends Database {
  public payloadQueries: number = 0;
  public onPayloadQuery: (() => void) | null = null;

  public override query<ReturnType, ParamsType extends SQLQueryBindings | SQLQueryBindings[]>(
    sql: string,
  ): Statement<ReturnType, QueryParameters<ParamsType>> {
    if (sql.startsWith("SELECT * FROM notices")) {
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
    CREATE TABLE notices (
      notice_id TEXT PRIMARY KEY, content TEXT NOT NULL, branch_name TEXT,
      created_at TEXT NOT NULL DEFAULT '2030-01-01T00:00:00.000Z',
      creator_generation INTEGER NOT NULL DEFAULT 1, creator_id TEXT NOT NULL DEFAULT 'reader',
      expires_at TEXT NOT NULL DEFAULT '2030-01-02T00:00:00.000Z', idempotency_key TEXT,
      kind TEXT NOT NULL DEFAULT 'handoff', repository_name TEXT NOT NULL DEFAULT 'audit/notices',
      resolution_note TEXT, resolved_at TEXT, resolved_by_generation INTEGER, resolved_by_id TEXT,
      withdrawn_at TEXT, withdrawn_by_generation INTEGER, withdrawn_by_id TEXT
    );
  `);
  return result;
}

function insert(connection: Database, index: number, content: string = "small"): void {
  connection
    .query<unknown, [string, string]>("INSERT INTO notices(notice_id, content) VALUES (?, ?)")
    .run(noticePageRow(index, content).notice_id, content);
}

function ids(page: ListNoticesResult): string[] {
  return page.notices.map((notice: Notice): string => notice.noticeId.value);
}

function read(connection: Database, overrides: Partial<ListNoticesQuery> = {}): ListNoticesResult {
  return readSqliteNoticePage(connection, { ...noticePageQuery(), ...overrides }, NOTICE_PAGE_NOW);
}

test("notice payload selection excludes both count and byte lookahead, including a legacy oversized suffix", (): void => {
  const connection: ObservedDatabase = database();
  try {
    insert(connection, 1);
    insert(connection, 2, "x".repeat(700_000));
    const first: ListNoticesResult = read(connection);
    expect(ids(first)).toEqual([noticePageRow(1, "").notice_id]);
    expect(first.nextCursor).not.toBeNull();
    expect(connection.payloadQueries).toBe(1);
    expect(ids(read(connection, { limit: 1 }))).toEqual(ids(first));
    expect(connection.payloadQueries).toBe(2);
    expect((): void => {
      read(connection, { cursor: first.nextCursor });
    }).toThrow("Stored notice exceeds the safe page size; contact the service owner.");
    expect(connection.payloadQueries).toBe(2);
  } finally {
    connection.close();
  }
});

test("notice candidate filters preserve repository, branch, kind, states and stable cursor ordering", (): void => {
  const connection: ObservedDatabase = database();
  try {
    for (let index: number = 1; index <= 7; index += 1) insert(connection, index);
    connection.exec(`
      UPDATE notices SET repository_name = 'other/repository' WHERE notice_id LIKE '%000001';
      UPDATE notices SET branch_name = 'feature/two' WHERE notice_id LIKE '%000002';
      UPDATE notices SET kind = 'decision' WHERE notice_id LIKE '%000003';
      UPDATE notices SET resolved_at = '2030-01-01T00:00:00.000Z', resolved_by_id = 'reader',
        resolved_by_generation = 1, resolution_note = 'done' WHERE notice_id LIKE '%000004';
      UPDATE notices SET withdrawn_at = '2030-01-01T00:00:00.000Z', withdrawn_by_id = 'reader',
        withdrawn_by_generation = 1, resolution_note = 'withdrawn' WHERE notice_id LIKE '%000005';
      UPDATE notices SET expires_at = '2030-01-01T00:00:00.000Z' WHERE notice_id LIKE '%000006';
      UPDATE notices SET created_at = '2029-12-31T23:59:59.000Z' WHERE notice_id LIKE '%000007';
    `);
    expect(
      ids(read(connection, { repositoryName: RepositoryName.parse("other/repository") })),
    ).toEqual([noticePageRow(1, "").notice_id]);
    expect(ids(read(connection, { branchName: BranchName.parse("feature/two") }))).toEqual([
      noticePageRow(2, "").notice_id,
    ]);
    expect(ids(read(connection, { kind: "decision" }))).toEqual([noticePageRow(3, "").notice_id]);
    for (const [state, index] of [
      ["resolved", 4],
      ["withdrawn", 5],
      ["expired", 6],
    ]) {
      if (state !== "resolved" && state !== "withdrawn" && state !== "expired")
        throw new Error("Invalid state fixture");
      if (typeof index !== "number") throw new Error("Invalid index fixture");
      expect(ids(read(connection, { state }))).toEqual([noticePageRow(index, "").notice_id]);
    }
    const open: ListNoticesResult = read(connection, { state: "open", limit: 2 });
    expect(ids(open)).toEqual([noticePageRow(2, "").notice_id, noticePageRow(3, "").notice_id]);
    expect(ids(read(connection, { state: "open", cursor: open.nextCursor }))).toEqual([
      noticePageRow(7, "").notice_id,
    ]);
    expect(
      ids(
        read(connection, {
          cursor: {
            createdAt: Instant.parse("2029-12-31T23:59:59.000Z"),
            noticeId: NoticeId.parse(noticePageRow(7, "").notice_id),
          },
        }),
      ),
    ).toEqual([]);
  } finally {
    connection.close();
  }
});

test("notice exact-byte boundary fits and the next UTF-8 byte moves the last row to the next page", (): void => {
  const connection: ObservedDatabase = database();
  try {
    const finalLength: number =
      (MAX_NOTICE_PAGE_BYTES - 18 * NOTICE_PAGE_ROW_BYTES) / 13 - 17 * 31_000;
    for (let index: number = 1; index <= 18; index += 1)
      insert(connection, index, "x".repeat(index === 18 ? finalLength : 31_000));
    expect(read(connection).notices).toHaveLength(18);
    expect(read(connection).nextCursor).toBeNull();
    connection
      .query<unknown, [string]>("UPDATE notices SET resolution_note = 'x' WHERE notice_id = ?")
      .run(noticePageRow(18, "").notice_id);
    const prefix: ListNoticesResult = read(connection);
    expect(prefix.notices).toHaveLength(17);
    expect(read(connection, { cursor: prefix.nextCursor }).notices).toHaveLength(1);
  } finally {
    connection.close();
  }
});

test("a concurrent SQLite writer cannot replace payloads after the notice preflight snapshot", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-notice-snapshot-"));
  const filename: string = join(directory, "notices.db");
  const reader: ObservedDatabase = database(filename);
  const writer: Database = new Database(filename);
  try {
    for (let index: number = 1; index <= 7; index += 1) insert(reader, index);
    reader.onPayloadQuery = (): void => {
      reader.onPayloadQuery = null;
      writer.query<unknown, [string]>("UPDATE notices SET content = ?").run("x".repeat(100_000));
    };
    expect(read(reader).notices.map((notice: Notice): string => notice.content.value)).toEqual(
      Array.from({ length: 7 }, (): string => "small"),
    );
    expect(read(reader).notices).toHaveLength(6);
  } finally {
    writer.close();
    reader.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("empty, failed and saturated notice reads release or reject reservations before payload queries", (): void => {
  const connection: ObservedDatabase = database();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_NOTICE_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const finish: () => void = scope.startHandler();
  try {
    withMaterializationScope(scope, (): void => {
      for (let index: number = 0; index < 10; index += 1) {
        expect(read(connection).notices).toEqual([]);
        expect(budget.reservedBytes).toBe(0);
      }
      insert(connection, 1);
      expect(read(connection).notices).toHaveLength(1);
      const previousQueries: number = connection.payloadQueries;
      expect((): void => {
        read(connection);
      }).toThrow("MCP materialization capacity reached");
      expect(connection.payloadQueries).toBe(previousQueries);
    });
    finish();
    scope.finishResponse();
    const failedScope: MaterializationScope = new MaterializationScope(budget);
    withMaterializationScope(failedScope, (): void => {
      connection.exec("DROP TABLE notices");
      expect((): void => {
        read(connection);
      }).toThrow();
      expect(budget.reservedBytes).toBe(0);
    });
    failedScope.finishResponse();
  } finally {
    finish();
    scope.finishResponse();
    connection.close();
  }
});
