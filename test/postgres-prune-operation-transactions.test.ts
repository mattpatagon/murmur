import { expect, test } from "bun:test";

import { UnknownAgentError } from "../src/domain/errors.js";
import type { GetMessagesQuery, SendMessageCommand } from "../src/domain/models.js";
import { Instant, Sequence } from "../src/domain/value-objects.js";
import { sendPostgresMessage } from "../src/storage/postgres-direct-message-store.js";
import {
  getPostgresMessages,
  getPostgresMessagesWithVersion,
  markPostgresMessagesRead,
} from "../src/storage/postgres-inbox-store.js";
import {
  PostgresPruneFixture,
  PRUNE_AGENT,
  PRUNE_MESSAGE,
  PRUNE_NOW,
  PRUNE_PRIVATE_ERROR,
  type PruneFailureStage,
  type PruneTransaction,
} from "./support/postgres-prune-operation-fixture.js";
import { baseMessageCommand } from "./support/store-fixture.js";

type Operation = "read" | "paired read" | "mark" | "empty mark";
const OPERATIONS: readonly Operation[] = ["read", "paired read", "mark", "empty mark"];
const QUERY: GetMessagesQuery = {
  agentId: PRUNE_AGENT,
  afterSequence: Sequence.zero(),
  unreadOnly: false,
  limit: 10,
  threadId: null,
  sessionKey: null,
};

async function invoke(fixture: PostgresPruneFixture, operation: Operation): Promise<unknown> {
  if (operation === "read") return await fixture.store.getMessages(QUERY);
  if (operation === "paired read") return await fixture.store.getMessagesWithVersion(QUERY);
  return await fixture.store.markMessagesRead({
    agentId: PRUNE_AGENT,
    messageIds: operation === "empty mark" ? [] : [PRUNE_MESSAGE],
  });
}

function eventCount(fixture: PostgresPruneFixture, event: string): number {
  return fixture.events.filter((entry: string): boolean => entry === event).length;
}

function firstTransaction(fixture: PostgresPruneFixture): PruneTransaction {
  const transaction: PruneTransaction | undefined = fixture.transactions[0];
  if (transaction === undefined) throw new Error("Missing preflight transaction");
  return transaction;
}

for (const operation of OPERATIONS) {
  test(`${operation} releases its fresh preflight transaction before acquiring the operation lease`, async (): Promise<void> => {
    const fixture: PostgresPruneFixture = new PostgresPruneFixture();
    try {
      await invoke(fixture, operation);
      expect(fixture.transactions).toHaveLength(2);
      expect(firstTransaction(fixture).events).toEqual(["context", "candidate"]);
      expect(fixture.events.slice(0, 7)).toEqual([
        "begin",
        "context",
        "candidate",
        "commit",
        "begin",
        "context",
        "agent",
      ]);
      expect(firstTransaction(fixture).status).toBe("committed");
      expect(eventCount(fixture, "context")).toBe(2);
      expect(eventCount(fixture, "candidate")).toBe(1);
      expect(eventCount(fixture, "agent")).toBe(1);
      expect(eventCount(fixture, "message-prune")).toBe(0);
      expect(fixture.clockCalls).toBe(1);
    } finally {
      await fixture.store.close();
    }
  });
}

test("send releases its preflight lease before the authoritative agent check fails", async (): Promise<void> => {
  const fixture: PostgresPruneFixture = new PostgresPruneFixture();
  fixture.agentAvailable = false;
  try {
    await expect(fixture.store.sendMessage(baseMessageCommand())).rejects.toBeInstanceOf(
      UnknownAgentError,
    );
    expect(fixture.transactions).toHaveLength(2);
    expect(firstTransaction(fixture).events).toEqual(["context", "candidate"]);
    expect(firstTransaction(fixture).status).toBe("committed");
    expect(
      fixture.transactions.map((transaction: PruneTransaction): string => transaction.status),
    ).toEqual(["committed", "rolled-back"]);
    expect(fixture.clockCalls).toBe(1);
  } finally {
    await fixture.store.close();
  }
});

test("a fresh false-to-true expiry snapshot commits pruning at the exact boundary", async (): Promise<void> => {
  const fixture: PostgresPruneFixture = new PostgresPruneFixture();
  const before: Instant = Instant.parse("2026-09-04T23:59:59.999Z");
  fixture.expiredMessages = 1;
  fixture.now = before;
  try {
    await invoke(fixture, "paired read");
    expect(fixture.expiredMessages).toBe(1);
    expect(eventCount(fixture, "message-prune")).toBe(0);
    const transactionOffset: number = fixture.transactions.length;
    fixture.now = PRUNE_NOW;
    await invoke(fixture, "mark");
    expect(fixture.expiredMessages).toBe(0);
    expect(fixture.acknowledged).toBe(1);
    expect(fixture.candidateTimes).toEqual([before.toISOString(), PRUNE_NOW.toISOString()]);
    expect(fixture.clockCalls).toBe(2);
    const pruning: PruneTransaction[] = fixture.transactions.slice(transactionOffset);
    expect(pruning).toHaveLength(4);
    const preflight: PruneTransaction | undefined = pruning[0];
    if (preflight === undefined) throw new Error("Missing boundary preflight transaction");
    expect(preflight.events).toEqual(["context", "candidate"]);
    expect(preflight.status).toBe("committed");
    expect(pruning.map((transaction: PruneTransaction): string => transaction.status)).toEqual([
      "committed",
      "committed",
      "committed",
      "committed",
    ]);
    expect(eventCount(fixture, "message-prune")).toBe(1);
  } finally {
    await fixture.store.close();
  }
});

for (const operation of OPERATIONS) {
  test(`committed pruning survives a later ${operation} failure without replaying the operation`, async (): Promise<void> => {
    const fixture: PostgresPruneFixture = new PostgresPruneFixture();
    fixture.expiredMessages = 1;
    fixture.agentAvailable = false;
    try {
      await expect(invoke(fixture, operation)).rejects.toBeInstanceOf(UnknownAgentError);
      expect(fixture.expiredMessages).toBe(0);
      expect(fixture.transactions).toHaveLength(4);
      expect(firstTransaction(fixture).events).toEqual(["context", "candidate"]);
      expect(
        fixture.transactions.map((transaction: PruneTransaction): string => transaction.status),
      ).toEqual(["committed", "committed", "committed", "rolled-back"]);
      expect(eventCount(fixture, "agent")).toBe(1);
      expect(eventCount(fixture, "candidate")).toBe(1);
      expect(eventCount(fixture, "page")).toBe(0);
      expect(eventCount(fixture, "ack")).toBe(0);
    } finally {
      await fixture.store.close();
    }
  });
}

test("invalid send provenance cannot move validation ahead of committed pruning", async (): Promise<void> => {
  const fixture: PostgresPruneFixture = new PostgresPruneFixture();
  fixture.expiredMessages = 1;
  const command: SendMessageCommand = {
    ...baseMessageCommand(),
    provenance: {
      messageKind: "orchestration_request",
      orchestratorPolicyId: null,
      senderAuthority: "peer",
    },
  };
  try {
    await expect(fixture.store.sendMessage(command)).rejects.toThrow(
      "An orchestration request requires a policy identifier",
    );
    expect(fixture.expiredMessages).toBe(0);
    expect(eventCount(fixture, "message-prune")).toBe(1);
    expect(eventCount(fixture, "agent")).toBe(0);
  } finally {
    await fixture.store.close();
  }
});

for (const stage of ["message-prune", "notice-prune"]) {
  test(`${stage} failure is normalized and prevents operation execution`, async (): Promise<void> => {
    const fixture: PostgresPruneFixture = new PostgresPruneFixture();
    fixture.expiredMessages = 1;
    fixture.failAt = stage === "message-prune" ? "message-prune" : "notice-prune";
    try {
      await expect(invoke(fixture, "mark")).rejects.toThrow(
        "Storage operation failed. Retry the request.",
      );
      expect(fixture.expiredMessages).toBe(stage === "message-prune" ? 1 : 0);
      expect(fixture.acknowledged).toBe(0);
      expect(eventCount(fixture, "agent")).toBe(0);
      expect(eventCount(fixture, "candidate")).toBe(1);
      expect(eventCount(fixture, stage)).toBe(1);
    } finally {
      await fixture.store.close();
    }
  });
}

for (const retained of [false, true]) {
  test(`remaining ${retained ? "broad lifecycle candidate" : "bounded message batch"} does not cause a prune loop`, async (): Promise<void> => {
    const fixture: PostgresPruneFixture = new PostgresPruneFixture();
    fixture.retainedCandidate = retained;
    fixture.expiredMessages = retained ? 0 : 1001;
    try {
      await invoke(fixture, "mark");
      expect(fixture.expiredMessages).toBe(retained ? 0 : 1);
      expect(fixture.retainedCandidate).toBe(retained);
      expect(fixture.acknowledged).toBe(1);
      expect(eventCount(fixture, "candidate")).toBe(1);
      expect(eventCount(fixture, "message-prune")).toBe(1);
      expect(eventCount(fixture, "agent")).toBe(1);
      expect(fixture.transactions).toHaveLength(4);
    } finally {
      await fixture.store.close();
    }
  });
}

const preflightFailures: readonly PruneFailureStage[] = [
  "begin",
  "context",
  "candidate",
  "preflight-commit",
];
for (const stage of preflightFailures) {
  test(`${stage} failure before operation entry is normalized and performs no data work`, async (): Promise<void> => {
    const fixture: PostgresPruneFixture = new PostgresPruneFixture();
    fixture.failAt = stage;
    fixture.expiredMessages = 1;
    try {
      await expect(invoke(fixture, "paired read")).rejects.toThrow(
        "Storage operation failed. Retry the request.",
      );
      expect(fixture.expiredMessages).toBe(1);
      expect(eventCount(fixture, "agent")).toBe(0);
      expect(eventCount(fixture, "message-prune")).toBe(0);
      expect(fixture.transactions).toHaveLength(1);
    } finally {
      await fixture.store.close();
    }
  });
}

for (const candidates of [false, true]) {
  for (const stage of ["version", "ack", "operation-commit"]) {
    test(`${stage} failure after operation entry remains raw with candidates=${String(candidates)}`, async (): Promise<void> => {
      const fixture: PostgresPruneFixture = new PostgresPruneFixture();
      fixture.expiredMessages = candidates ? 1 : 0;
      fixture.failAt =
        stage === "version" ? "version" : stage === "ack" ? "ack" : "operation-commit";
      try {
        await expect(invoke(fixture, stage === "version" ? "paired read" : "mark")).rejects.toBe(
          fixture.failure,
        );
        expect(fixture.failure.message).toBe(PRUNE_PRIVATE_ERROR);
        expect(fixture.acknowledged).toBe(0);
        expect(fixture.expiredMessages).toBe(0);
        expect(eventCount(fixture, "agent")).toBe(1);
        expect(eventCount(fixture, "candidate")).toBe(1);
      } finally {
        await fixture.store.close();
      }
    });
  }
}

test("a no-candidate preflight commit failure prevents acquiring an operation lease", async (): Promise<void> => {
  const fixture: PostgresPruneFixture = new PostgresPruneFixture();
  fixture.failAt = "preflight-commit";
  try {
    await expect(invoke(fixture, "mark")).rejects.toThrow(
      "Storage operation failed. Retry the request.",
    );
    expect(fixture.transactions).toHaveLength(1);
    expect(firstTransaction(fixture).status).toBe("rolled-back");
    expect(eventCount(fixture, "agent")).toBe(0);
    expect(fixture.acknowledged).toBe(0);
  } finally {
    await fixture.store.close();
  }
});

test("the post-prune operation context failure remains an operation error", async (): Promise<void> => {
  const fixture: PostgresPruneFixture = new PostgresPruneFixture();
  fixture.expiredMessages = 1;
  fixture.failAt = "context";
  fixture.failureContextOrdinal = 4;
  try {
    await expect(invoke(fixture, "read")).rejects.toBe(fixture.failure);
    expect(fixture.expiredMessages).toBe(0);
    expect(eventCount(fixture, "agent")).toBe(0);
  } finally {
    await fixture.store.close();
  }
});

test("malformed preflight rows fail closed before any operation or pruning", async (): Promise<void> => {
  for (const rows of [
    [],
    [{ candidates: "false" }],
    [{ candidates: false }, { candidates: true }],
  ]) {
    const fixture: PostgresPruneFixture = new PostgresPruneFixture();
    fixture.candidateRows = { value: rows };
    try {
      await expect(invoke(fixture, "read")).rejects.toThrow();
      expect(eventCount(fixture, "agent")).toBe(0);
      expect(eventCount(fixture, "message-prune")).toBe(0);
    } finally {
      await fixture.store.close();
    }
  }
});

test("direct adapter APIs retain ordinary tenant transactions without implicit pruning", async (): Promise<void> => {
  const fixture: PostgresPruneFixture = new PostgresPruneFixture();
  fixture.expiredMessages = 1;
  try {
    expect(await getPostgresMessages(fixture.database, fixture.tenant, QUERY, PRUNE_NOW)).toEqual(
      [],
    );
    expect(
      (await getPostgresMessagesWithVersion(fixture.database, fixture.tenant, QUERY, PRUNE_NOW))
        .inboxVersion.value,
    ).toBe(0);
    expect(
      (
        await markPostgresMessagesRead(
          fixture.database,
          fixture.tenant,
          { agentId: PRUNE_AGENT, messageIds: [] },
          PRUNE_NOW,
        )
      ).updated,
    ).toBe(0);
    fixture.agentAvailable = false;
    await expect(
      sendPostgresMessage(fixture.database, fixture.tenant, baseMessageCommand(), PRUNE_NOW),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    expect(fixture.transactions).toHaveLength(4);
    expect(eventCount(fixture, "context")).toBe(4);
    expect(eventCount(fixture, "candidate")).toBe(0);
    expect(fixture.expiredMessages).toBe(1);
    expect(fixture.clockCalls).toBe(0);
  } finally {
    await fixture.store.close();
  }
});
