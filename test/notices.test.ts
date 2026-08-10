import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentGeneration,
  NoticeContent,
  ResolutionNote,
  SessionKey,
} from "../src/domain/lifecycle-values.js";
import type {
  ListNoticesQuery,
  ListNoticesResult,
  Notice,
  PostNoticeCommand,
  PostNoticeResult,
  ResolveNoticeResult,
  WithdrawNoticeResult,
} from "../src/domain/notice-models.js";
import type { RegisterAgentResult } from "../src/domain/models.js";
import {
  AgentId,
  BranchName,
  DisplayName,
  IdempotencyKey,
  Instant,
  RepositoryName,
} from "../src/domain/value-objects.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

type NoticeFixture = {
  readonly clock: MutableClock;
  readonly path: string;
  readonly store: SqliteMessageStore;
};

function withNotices(run: (fixture: NoticeFixture) => void): void {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-notices-"));
  const path: string = join(directory, "messages.db");
  const clock: MutableClock = new MutableClock(Instant.parse("2026-04-01T00:00:00.000Z"));
  const store: SqliteMessageStore = new SqliteMessageStore(path, clock);
  for (const id of ["alice", "bob"]) {
    store.registerAgent({
      agentId: AgentId.parse(id),
      displayName: DisplayName.parse(id),
      metadata: { repository: "mattpatagon/murmur" },
      sessionKey: SessionKey.parse(`${id}-pane`),
    });
  }
  try {
    run({ clock, path, store });
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function postCommand(
  content: string,
  key: string,
  kind: PostNoticeCommand["kind"] = "handoff",
  hours: number = 24,
): PostNoticeCommand {
  return {
    actorId: AgentId.parse("alice"),
    branchName: BranchName.parse("feature/lifecycle"),
    content: NoticeContent.parse(content),
    expiresInHours: hours,
    idempotencyKey: IdempotencyKey.parse(key),
    kind,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    sessionKey: SessionKey.parse("alice-pane"),
  };
}

function list(
  store: SqliteMessageStore,
  state: "all" | Notice["state"],
  limit: number = 100,
): readonly Notice[] {
  return store.listNotices({
    actorId: AgentId.parse("bob"),
    branchName: null,
    cursor: null,
    kind: null,
    limit,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    sessionKey: null,
    state,
  }).notices;
}

function requireNotice(notices: readonly Notice[]): Notice {
  const notice: Notice | undefined = notices[0];
  if (notice === undefined) {
    throw new Error("Expected notice");
  }
  return notice;
}

test("notice TTL boundaries and idempotency are exact", (): void => {
  withNotices(({ clock, store }: NoticeFixture): void => {
    const first: PostNoticeResult = store.postNotice(
      postCommand("handoff ready", "notice-1", "handoff", 1),
    );
    const retry: PostNoticeResult = store.postNotice(
      postCommand("handoff ready", "notice-1", "handoff", 1),
    );
    expect(retry.duplicate).toBe(true);
    expect(retry.notice.noticeId.value).toBe(first.notice.noticeId.value);
    expect(
      (): PostNoticeResult => store.postNotice(postCommand("changed", "notice-1", "handoff", 1)),
    ).toThrow("already used");
    clock.set(Instant.parse("2026-04-01T00:59:59.999Z"));
    expect(list(store, "open")).toHaveLength(1);
    clock.set(Instant.parse("2026-04-01T01:00:00.000Z"));
    expect(list(store, "open")).toHaveLength(0);
    expect(requireNotice(list(store, "expired")).noticeId.value).toBe(first.notice.noticeId.value);
    expect(
      (): ResolveNoticeResult =>
        store.resolveNotice({
          actorId: AgentId.parse("bob"),
          noticeId: first.notice.noticeId,
          repositoryName: RepositoryName.parse("mattpatagon/murmur"),
          resolutionNote: ResolutionNote.parse("too late"),
          sessionKey: SessionKey.parse("bob-pane"),
        }),
    ).toThrow("no longer open");
  });
});

test("any actor resolves, only the stable creator withdraws, and generation bumps do not break ownership", (): void => {
  withNotices(({ store }: NoticeFixture): void => {
    const blocker: PostNoticeResult = store.postNotice(
      postCommand("CI blocks merge", "blocker-1", "blocker"),
    );
    const resolved: ResolveNoticeResult = store.resolveNotice({
      actorId: AgentId.parse("bob"),
      noticeId: blocker.notice.noticeId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      resolutionNote: ResolutionNote.parse("CI is green"),
      sessionKey: SessionKey.parse("bob-pane"),
    });
    expect(resolved.notice.state).toBe("resolved");
    const resolver: AgentId | null = resolved.notice.resolvedById;
    if (resolver === null) {
      throw new Error("Expected notice resolver");
    }
    expect(resolver.value).toBe("bob");
    expect(
      store.resolveNotice({
        actorId: AgentId.parse("bob"),
        noticeId: blocker.notice.noticeId,
        repositoryName: RepositoryName.parse("mattpatagon/murmur"),
        resolutionNote: ResolutionNote.parse("retry"),
        sessionKey: SessionKey.parse("bob-pane"),
      }).alreadyResolved,
    ).toBe(true);

    const ownership: PostNoticeResult = store.postNotice(
      postCommand("Alice owns migrations", "ownership-1", "ownership"),
    );
    expect(
      (): WithdrawNoticeResult =>
        store.withdrawNotice({
          actorId: AgentId.parse("bob"),
          noticeId: ownership.notice.noticeId,
          repositoryName: RepositoryName.parse("mattpatagon/murmur"),
          resolutionNote: ResolutionNote.parse("not mine"),
          sessionKey: SessionKey.parse("bob-pane"),
        }),
    ).toThrow("creating agent identity");
    store.closeAgent({
      agentId: AgentId.parse("alice"),
      closeReason: "completed",
      expectedGeneration: AgentGeneration.parse(1),
    });
    const reopened: RegisterAgentResult = store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("alice"),
      metadata: { repository: "mattpatagon/murmur" },
      sessionKey: SessionKey.parse("alice-new-pane"),
    });
    expect(reopened.agent.generation.value).toBe(2);
    const withdrawn: WithdrawNoticeResult = store.withdrawNotice({
      actorId: AgentId.parse("alice"),
      noticeId: ownership.notice.noticeId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      resolutionNote: ResolutionNote.parse("work transferred"),
      sessionKey: SessionKey.parse("alice-new-pane"),
    });
    expect(withdrawn.notice.state).toBe("withdrawn");
    const withdrawnGeneration: AgentGeneration | null = withdrawn.notice.withdrawnByGeneration;
    if (withdrawnGeneration === null) {
      throw new Error("Expected notice withdrawal generation");
    }
    expect(withdrawnGeneration.value).toBe(2);
    expect(
      (): WithdrawNoticeResult =>
        store.withdrawNotice({
          actorId: AgentId.parse("bob"),
          noticeId: ownership.notice.noticeId,
          repositoryName: RepositoryName.parse("mattpatagon/murmur"),
          resolutionNote: ResolutionNote.parse("still not mine"),
          sessionKey: SessionKey.parse("bob-pane"),
        }),
    ).toThrow("creating agent identity");
  });
});

test("state filtering happens before pagination", (): void => {
  withNotices(({ store }: NoticeFixture): void => {
    const olderOpen: PostNoticeResult = store.postNotice(postCommand("still open", "open-1"));
    const newerResolved: PostNoticeResult = store.postNotice(postCommand("done", "done-1"));
    store.resolveNotice({
      actorId: AgentId.parse("bob"),
      noticeId: newerResolved.notice.noticeId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      resolutionNote: ResolutionNote.parse("done"),
      sessionKey: SessionKey.parse("bob-pane"),
    });
    const page: readonly Notice[] = list(store, "open", 1);
    expect(page).toHaveLength(1);
    expect(requireNotice(page).noticeId.value).toBe(olderOpen.notice.noticeId.value);
  });
});

test("notice keyset cursors traverse filtered pages without gaps or duplicates", (): void => {
  withNotices(({ store }: NoticeFixture): void => {
    for (const key of ["cursor-a", "cursor-b", "cursor-c"]) {
      store.postNotice(postCommand(key, key, "decision"));
    }
    const query: ListNoticesQuery = {
      actorId: AgentId.parse("bob"),
      branchName: null,
      cursor: null,
      kind: "decision",
      limit: 2,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      sessionKey: null,
      state: "open",
    };
    const first: ListNoticesResult = store.listNotices(query);
    expect(first.notices).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second: ListNoticesResult = store.listNotices({
      ...query,
      cursor: first.nextCursor,
    });
    expect(second.notices).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids: string[] = [...first.notices, ...second.notices].map(
      (notice: Notice): string => notice.noticeId.value,
    );
    expect(new Set(ids).size).toBe(3);
  });
});

test("SQLite rejects notice actor identifiers that PostgreSQL cannot store", (): void => {
  withNotices(({ path, store }: NoticeFixture): void => {
    store.close();
    const database: Database = new Database(path);
    try {
      expect((): void => {
        database.exec(`
          INSERT INTO notices(
            notice_id, kind, creator_id, creator_generation, repository_name,
            content, created_at, expires_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000001', 'handoff', 'invalid creator', 1,
            'mattpatagon/murmur', 'must fail', '2026-04-01T00:00:00.000Z',
            '2026-04-02T00:00:00.000Z'
          )
        `);
      }).toThrow("CHECK constraint failed");
    } finally {
      database.close();
    }
  });
});

test("retained-notice count quota is exact and terminal rows remain charged until audit expiry", (): void => {
  withNotices(({ clock, path, store }: NoticeFixture): void => {
    store.close();
    const database: Database = new Database(path);
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
      )
      INSERT INTO notices(
        notice_id, kind, creator_id, creator_generation, repository_name,
        content, created_at, expires_at
      ) SELECT
        printf('00000000-0000-4000-8000-%012d', value), 'handoff', 'alice', 1,
        'mattpatagon/murmur', 'seed', '2026-04-01T00:00:00.000Z',
        '2026-04-02T00:00:00.000Z'
      FROM sequence
    `);
    database.close();
    const reopened: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      expect(
        (): PostNoticeResult => reopened.postNotice(postCommand("overflow", "overflow-notice")),
      ).toThrow("capacity");
      clock.set(Instant.parse("2026-05-03T00:00:00.000Z"));
      reopened.pruneExpired(clock.now());
      reopened.registerAgent({
        agentId: AgentId.parse("alice"),
        displayName: DisplayName.parse("alice"),
        metadata: { repository: "mattpatagon/murmur" },
        sessionKey: SessionKey.parse("alice-returned"),
      });
      expect(
        reopened.postNotice(postCommand("capacity released", "replacement-notice")).duplicate,
      ).toBe(false);
    } finally {
      reopened.close();
    }
  });
});
