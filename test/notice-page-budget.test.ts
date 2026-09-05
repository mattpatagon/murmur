import { expect, test } from "bun:test";

import { NoticeContent, SessionKey } from "../src/domain/lifecycle-values.js";
import type { ListNoticesQuery, ListNoticesResult, Notice } from "../src/domain/notice-models.js";
import { AgentId, DisplayName, Instant, RepositoryName } from "../src/domain/value-objects.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

const maximumBytes: number = 8 * 1024 * 1024;
const query: ListNoticesQuery = {
  actorId: AgentId.parse("reader"),
  branchName: null,
  cursor: null,
  kind: null,
  limit: 500,
  repositoryName: RepositoryName.parse("audit/notices"),
  sessionKey: null,
  state: "all",
};

function fixture(): SqliteMessageStore {
  const store: SqliteMessageStore = new SqliteMessageStore(
    ":memory:",
    new MutableClock(Instant.parse("2030-01-01T00:00:00.000Z")),
  );
  store.registerAgent({
    agentId: query.actorId,
    displayName: DisplayName.parse("Reader"),
    metadata: {},
  });
  return store;
}

function post(store: SqliteMessageStore, content: string): void {
  store.postNotice({
    actorId: query.actorId,
    branchName: null,
    content: NoticeContent.parse(content),
    expiresInHours: 24,
    idempotencyKey: null,
    kind: "handoff",
    repositoryName: query.repositoryName,
    sessionKey: SessionKey.default(),
  });
}

test("notice pages return a byte-fitting prefix and the existing cursor drains every remaining notice", (): void => {
  const store: SqliteMessageStore = fixture();
  try {
    for (let index: number = 0; index < 7; index += 1) post(store, "\u0001".repeat(100_000));
    const first: ListNoticesResult = store.listNotices(query);
    expect(first.notices).toHaveLength(6);
    expect(first.nextCursor).not.toBeNull();
    const second: ListNoticesResult = store.listNotices({ ...query, cursor: first.nextCursor });
    expect(second.notices).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.notices, ...second.notices].map(
          (notice: Notice): string => notice.noticeId.value,
        ),
      ).size,
    ).toBe(7);
  } finally {
    store.close();
  }
});

test("notice payloads hold their shared byte reservation until both handler and response finish", (): void => {
  const store: SqliteMessageStore = fixture();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(maximumBytes);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const finish: () => void = scope.startHandler();
  try {
    post(store, "small notice");
    withMaterializationScope(scope, (): void => {
      expect(store.listNotices(query).notices).toHaveLength(1);
    });
    expect(budget.reservedBytes).toBe(13 * Buffer.byteLength("small notice") + 16 * 1024);
    finish();
    expect(budget.reservedBytes).toBeGreaterThan(0);
    scope.finishResponse();
    expect(budget.reservedBytes).toBe(0);
  } finally {
    finish();
    scope.finishResponse();
    store.close();
  }
});
