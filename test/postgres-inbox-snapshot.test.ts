import { expect, test } from "bun:test";

import { StorageCorruptionError, UnknownAgentError } from "../src/domain/errors.js";
import { AgentGeneration } from "../src/domain/lifecycle-values.js";
import type { GetMessagesQuery } from "../src/domain/models.js";
import { MessageId, Sequence, ThreadId } from "../src/domain/value-objects.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { InboxPageCapacityError, MAX_INBOX_PAGE_BYTES } from "../src/storage/inbox-page-budget.js";
import type { InboxReadResult } from "../src/storage/message-store.js";
import {
  type DeferredRead,
  deferred,
  InboxReadFixture,
  READ_AGENT,
  READ_BYTES,
  READ_NOW,
  type ReadStatement,
} from "./support/inbox-read-fixture.js";

const QUERY: GetMessagesQuery = {
  afterSequence: Sequence.parse(2),
  agentId: READ_AGENT,
  generation: null,
  limit: 1,
  sessionKey: null,
  threadId: ThreadId.parse("selected-thread"),
  unreadOnly: true,
};

function expectOneSnapshot(fixture: InboxReadFixture): void {
  expect(fixture.transactions).toHaveLength(2);
  expect(fixture.completedTransactions).toBe(2);
  expect(fixture.clockCalls).toBe(1);
  const preflight: ReadStatement[] | undefined = fixture.transactions[0];
  const operation: ReadStatement[] | undefined = fixture.transactions[1];
  if (preflight === undefined || operation === undefined) throw new Error("Missing transactions");
  expect(preflight).toHaveLength(2);
  expect(preflight[0]).toHaveProperty("text", expect.stringContaining("set_config"));
  expect(preflight[1]).toHaveProperty("text", expect.stringContaining("AS candidates"));
  // Context, complete Agent validation, then one gated page/high-water statement.
  expect(operation).toHaveLength(3);
  const page: ReadStatement | undefined = operation[2];
  if (page === undefined) throw new Error("Missing inbox snapshot");
  expect(page.text).toContain("WITH candidates AS MATERIALIZED");
  expect(page.text).toContain("AS inbox_version");
  expect(page.text).toContain("murmur.e2ee_messages");
  expect(page.values).toContain(fixture.tenant.value);
  expect(page.values).toContain(READ_NOW.toISOString());
}

for (const generation of [null, AgentGeneration.parse(7)]) {
  test(`PostgreSQL inbox page and independent version use one data statement for generation ${generation === null ? "current" : "historical"}`, async (): Promise<void> => {
    const fixture: InboxReadFixture = new InboxReadFixture();
    if (generation !== null)
      fixture.row = { ...fixture.row, recipient_generation: generation.value };
    try {
      const result: InboxReadResult = await fixture.store.getMessagesWithVersion({
        ...QUERY,
        generation,
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toHaveProperty("sequence.value", 3);
      expect(result.messages[0]).toHaveProperty(
        "recipientGeneration.value",
        generation === null ? 1 : 7,
      );
      expect(result.inboxVersion.value).toBe(17);
      expectOneSnapshot(fixture);
    } finally {
      await fixture.store.close();
    }
  });
}

test("empty filtered pages keep an independent nonzero high-water without a second SELECT or retained bytes", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  fixture.pageOverride = [];
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const complete: () => void = scope.startHandler();
  try {
    const result: InboxReadResult = await withMaterializationScope(
      scope,
      async (): Promise<InboxReadResult> =>
        await fixture.store.getMessagesWithVersion({
          ...QUERY,
          afterSequence: Sequence.parse(100),
        }),
    );
    expect(result.messages).toEqual([]);
    expect(result.inboxVersion.value).toBe(17);
    expect(budget.reservedBytes).toBe(0);
    expectOneSnapshot(fixture);
  } finally {
    complete();
    scope.finishResponse();
    await fixture.store.close();
  }
});

test("standalone message reads still avoid the unused encrypted high-water query", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  try {
    expect(await fixture.store.getMessages(QUERY)).toHaveLength(1);
    expect(fixture.transactions[1]).toHaveLength(3);
    expect(
      fixture
        .statements()
        .some((statement: ReadStatement): boolean =>
          statement.text.includes("murmur.e2ee_messages"),
        ),
    ).toBe(false);
  } finally {
    await fixture.store.close();
  }
});

test("unknown and malformed current agents fail before the combined payload reservation", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const complete: () => void = scope.startHandler();
  const validAgent: typeof fixture.agent = fixture.agent;
  try {
    fixture.agent = null;
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<InboxReadResult> => await fixture.store.getMessagesWithVersion(QUERY),
      ),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    if (validAgent === null) throw new Error("Missing fixture agent");
    fixture.agent = { ...validAgent, generation: 0 };
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<InboxReadResult> => await fixture.store.getMessagesWithVersion(QUERY),
      ),
    ).rejects.toThrow();
    expect(budget.reservedBytes).toBe(0);
    expect(
      fixture
        .statements()
        .some((statement: ReadStatement): boolean =>
          statement.text.includes("WITH candidates AS MATERIALIZED"),
        ),
    ).toBe(false);
  } finally {
    complete();
    scope.finishResponse();
    await fixture.store.close();
  }
});

test("an oversized page retains the actionable failure and releases its settled query reservation", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  fixture.pageOverride = [{ estimated_page_bytes: MAX_INBOX_PAGE_BYTES + 1 }];
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const complete: () => void = scope.startHandler();
  try {
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<InboxReadResult> => await fixture.store.getMessagesWithVersion(QUERY),
      ),
    ).rejects.toBeInstanceOf(InboxPageCapacityError);
    expect(budget.reservedBytes).toBe(0);
    expect(fixture.transactions[1]).toHaveLength(3);
  } finally {
    complete();
    scope.finishResponse();
    await fixture.store.close();
  }
});

for (const abandonedHandler of [false, true]) {
  test(`pending snapshot bytes survive response cancellation${abandonedHandler ? " and an abandoned outer handler" : " until actual handler completion"}`, async (): Promise<void> => {
    const fixture: InboxReadFixture = new InboxReadFixture();
    const entered: DeferredRead = deferred();
    const release: DeferredRead = deferred();
    fixture.pageAction = async (): Promise<void> => {
      entered.resolve();
      await release.promise;
    };
    const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const complete: () => void = scope.startHandler();
    const operation: Promise<InboxReadResult> = withMaterializationScope(
      scope,
      async (): Promise<InboxReadResult> => await fixture.store.getMessagesWithVersion(QUERY),
    );
    try {
      await entered.promise;
      expect(budget.reservedBytes).toBe(MAX_INBOX_PAGE_BYTES);
      scope.finishResponse();
      if (abandonedHandler) complete();
      expect(budget.reservedBytes).toBe(MAX_INBOX_PAGE_BYTES);
      expect(fixture.completedTransactions).toBe(1);
      release.resolve();
      const result: InboxReadResult = await operation;
      expect(result.messages).toHaveLength(1);
      expect(result.inboxVersion.value).toBe(17);
      expect(budget.reservedBytes).toBe(abandonedHandler ? 0 : READ_BYTES);
      complete();
      expect(budget.reservedBytes).toBe(0);
    } finally {
      release.resolve();
      await operation;
      complete();
      scope.finishResponse();
      await fixture.store.close();
    }
  });
}

test("a failed pending snapshot releases bytes only after its real query settles", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  const entered: DeferredRead = deferred();
  const release: DeferredRead = deferred();
  fixture.pageAction = async (): Promise<void> => {
    entered.resolve();
    await release.promise;
    throw new Error("Snapshot fixture query failed");
  };
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const complete: () => void = scope.startHandler();
  const operation: Promise<InboxReadResult> = withMaterializationScope(
    scope,
    async (): Promise<InboxReadResult> => await fixture.store.getMessagesWithVersion(QUERY),
  );
  const rejected: Promise<boolean> = operation.then(
    (): boolean => false,
    (error: unknown): boolean =>
      error instanceof Error && error.message === "Snapshot fixture query failed",
  );
  try {
    await entered.promise;
    scope.finishResponse();
    complete();
    expect(budget.reservedBytes).toBe(MAX_INBOX_PAGE_BYTES);
    release.resolve();
    expect(await rejected).toBe(true);
    expect(budget.reservedBytes).toBe(0);
    expect(fixture.completedTransactions).toBe(1);
  } finally {
    release.resolve();
    await rejected;
    complete();
    scope.finishResponse();
    await fixture.store.close();
  }
});

for (const invalid of [
  "negative",
  "unsafe",
  "behind-page",
  "missing",
  "inconsistent",
  "unknown-field",
  "missing-empty-field",
  "nonzero-empty-budget",
  "extra-empty-row",
]) {
  test(`combined inbox metadata rejects ${invalid} values before accepting a page`, async (): Promise<void> => {
    const fixture: InboxReadFixture = new InboxReadFixture();
    const valid: Record<string, unknown> = {
      ...fixture.row,
      estimated_page_bytes: READ_BYTES,
      inbox_version: 17,
    };
    if (invalid === "negative") fixture.snapshotOverride = [{ ...valid, inbox_version: -1 }];
    if (invalid === "unsafe")
      fixture.snapshotOverride = [{ ...valid, inbox_version: Number.MAX_SAFE_INTEGER + 1 }];
    if (invalid === "behind-page") fixture.snapshotOverride = [{ ...valid, inbox_version: 2 }];
    if (invalid === "missing")
      fixture.snapshotOverride = [{ ...fixture.row, estimated_page_bytes: READ_BYTES }];
    if (invalid === "inconsistent")
      fixture.snapshotOverride = [
        { ...valid, estimated_page_bytes: 2 * READ_BYTES },
        {
          ...valid,
          estimated_page_bytes: 2 * READ_BYTES,
          inbox_version: 18,
          message_id: MessageId.generate().value,
          sequence: 4,
        },
      ];
    if (invalid === "unknown-field")
      fixture.snapshotOverride = [{ ...fixture.emptySnapshot(), unexpected: null }];
    if (invalid === "missing-empty-field")
      fixture.snapshotOverride = [
        Object.fromEntries(
          Object.entries(fixture.emptySnapshot()).filter(
            ([field]: [string, unknown]): boolean => field !== "content",
          ),
        ),
      ];
    if (invalid === "nonzero-empty-budget")
      fixture.snapshotOverride = [{ ...fixture.emptySnapshot(), estimated_page_bytes: READ_BYTES }];
    if (invalid === "extra-empty-row")
      fixture.snapshotOverride = [fixture.emptySnapshot(), fixture.emptySnapshot()];
    const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const complete: () => void = scope.startHandler();
    try {
      await expect(
        withMaterializationScope(
          scope,
          async (): Promise<InboxReadResult> =>
            await fixture.store.getMessagesWithVersion({ ...QUERY, limit: 2 }),
        ),
      ).rejects.toBeInstanceOf(StorageCorruptionError);
      expect(budget.reservedBytes).toBe(0);
    } finally {
      complete();
      scope.finishResponse();
      await fixture.store.close();
    }
  });
}

test("an empty inbox sentinel cannot discard any non-null payload field", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  try {
    for (const field of Object.keys(fixture.row)) {
      fixture.snapshotOverride = [
        { ...fixture.emptySnapshot(), [field]: "private fixture sentinel" },
      ];
      await expect(fixture.store.getMessagesWithVersion(QUERY)).rejects.toBeInstanceOf(
        StorageCorruptionError,
      );
    }
  } finally {
    await fixture.store.close();
  }
});
