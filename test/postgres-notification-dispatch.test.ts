import { expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { AgentGeneration } from "../src/domain/lifecycle-values.js";
import type { Agent } from "../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  Instant,
  Sequence,
  SystemClock,
  TenantId,
} from "../src/domain/value-objects.js";
import type { MessageStore } from "../src/storage/message-store.js";
import {
  type InboxDispatcherTimeSource,
  PostgresInboxDispatcher,
  SYSTEM_INBOX_DISPATCHER_TIME,
} from "../src/storage/postgres-inbox-dispatcher.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";

type Signal = { readonly promise: Promise<void>; readonly resolve: () => void };

function fakeReads(store: MessageStore): void {
  store.getAgent = async (agentId: AgentId): Promise<Agent> => ({
    agentId,
    authority: "peer",
    closedAt: null,
    closeReason: null,
    createdAt: Instant.parse("2026-01-01T00:00:00.000Z"),
    displayName: DisplayName.parse("Notification fixture"),
    generation: AgentGeneration.parse(1),
    lastSeenAt: Instant.parse("2026-01-01T00:00:00.000Z"),
    leaseExpiresAt: Instant.parse("2026-01-01T01:00:00.000Z"),
    liveSessionCount: 1,
    metadata: {},
    state: "active",
  });
  store.getInboxVersion = async (): Promise<Sequence> => Sequence.zero();
}

function fakeStore(
  time: InboxDispatcherTimeSource = SYSTEM_INBOX_DISPATCHER_TIME,
): PostgresMessageStore {
  const database: Sql = postgres({ host: "127.0.0.1", max: 1, port: 1 });
  const shared: unknown = {
    closed: false,
    closePromise: null,
    dispatcher: new PostgresInboxDispatcher({
      readVersion: async (): Promise<Sequence> => Sequence.zero(),
      reportError: (): void => {},
      time,
    }),
    listener: null,
  };
  // Exercise the actual listener path while keeping SQL and subscriber completion deterministic.
  const candidate: unknown = Reflect.construct(PostgresMessageStore, [
    database,
    new SystemClock(),
    TenantId.founding(),
    shared,
    true,
  ]);
  if (!(candidate instanceof PostgresMessageStore)) throw new Error("Invalid notification fixture");
  fakeReads(candidate);
  return candidate;
}

function emit(store: PostgresMessageStore, tenantId: TenantId, sequence: number): void {
  const listener: unknown = Reflect.get(store, "enqueueNotification");
  if (typeof listener !== "function") throw new Error("Notification listener unavailable");
  Reflect.apply(listener, store, [
    JSON.stringify({
      agent_id: "shared-agent",
      sequence,
      tenant_id: tenantId.value,
    }),
  ]);
}

test("a stalled PostgreSQL subscriber does not block another tenant's notifications", async (): Promise<void> => {
  const store: PostgresMessageStore = fakeStore();
  const firstEntered: Signal = Promise.withResolvers<void>();
  const releaseFirst: Signal = Promise.withResolvers<void>();
  const otherTenant: TenantId = TenantId.generate();
  const otherStore: MessageStore = store.scope(otherTenant);
  fakeReads(otherStore);
  let healthyCalls: number = 0;
  try {
    await store.watchInbox(
      AgentId.parse("shared-agent"),
      Sequence.zero(),
      async (): Promise<void> => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    );
    await otherStore.watchInbox(
      AgentId.parse("shared-agent"),
      Sequence.zero(),
      async (): Promise<void> => {
        healthyCalls += 1;
      },
    );
    emit(store, TenantId.founding(), 1);
    await firstEntered.promise;
    emit(store, otherTenant, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(healthyCalls).toBe(1);
  } finally {
    releaseFirst.resolve();
    await store.close();
  }
});

test("PostgreSQL store shutdown does not await an unresolved subscriber", async (): Promise<void> => {
  const store: PostgresMessageStore = fakeStore();
  const entered: Signal = Promise.withResolvers<void>();
  const blocked: Signal = Promise.withResolvers<void>();
  try {
    await store.watchInbox(
      AgentId.parse("shared-agent"),
      Sequence.zero(),
      async (): Promise<void> => {
        entered.resolve();
        await blocked.promise;
      },
    );
    emit(store, TenantId.founding(), 1);
    await entered.promise;
    await store.close();
    await store.close();
    expect((): MessageStore => store.scope(TenantId.founding())).toThrow("closed");
  } finally {
    blocked.resolve();
    await store.close();
  }
});

test("PostgreSQL store closes its database after listener cleanup times out and preserves the failure", async (): Promise<void> => {
  const wakes: Set<() => void> = new Set<() => void>();
  const time: InboxDispatcherTimeSource = {
    now: (): number => 0,
    schedule: (_milliseconds: number, wake: () => void): (() => void) => {
      wakes.add(wake);
      return (): void => {
        wakes.delete(wake);
      };
    },
  };
  const store: PostgresMessageStore = fakeStore(time);
  const blocked: Signal = Promise.withResolvers<void>();
  const shared: unknown = Reflect.get(store, "shared");
  const database: unknown = Reflect.get(store, "database");
  if (typeof shared !== "object" || shared === null || typeof database !== "function") {
    throw new Error("Invalid cleanup fixture");
  }
  let databaseCloses: number = 0;
  let listenerCloses: number = 0;
  Reflect.set(shared, "listener", {
    unlisten: async (): Promise<void> => {
      listenerCloses += 1;
      await blocked.promise;
    },
  });
  Reflect.set(database, "end", async (): Promise<void> => {
    databaseCloses += 1;
  });
  try {
    const close: Promise<string> = store.close().then(
      (): string => "closed",
      (error: unknown): string => {
        expect(error).toHaveProperty("message", "Inbox notification cleanup timed out");
        return "timed out";
      },
    );
    await Promise.resolve();
    for (const wake of Array.from(wakes)) {
      wakes.delete(wake);
      wake();
    }
    expect(await close).toBe("timed out");
    expect(databaseCloses).toBe(1);
    expect(listenerCloses).toBe(1);
    expect(wakes.size).toBe(0);
    await expect(store.close()).rejects.toThrow("cleanup timed out");
    expect(databaseCloses).toBe(1);
  } finally {
    blocked.resolve();
  }
});

test("PostgreSQL notification bursts retain only the latest pending inbox sequence", async (): Promise<void> => {
  const store: PostgresMessageStore = fakeStore();
  const firstEntered: Signal = Promise.withResolvers<void>();
  const releaseFirst: Signal = Promise.withResolvers<void>();
  const latestDelivered: Signal = Promise.withResolvers<void>();
  const delivered: number[] = [];
  try {
    await store.watchInbox(
      AgentId.parse("shared-agent"),
      Sequence.zero(),
      async (sequence: Sequence): Promise<void> => {
        delivered.push(sequence.value);
        if (sequence.value === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        if (sequence.value === 100) latestDelivered.resolve();
      },
    );
    emit(store, TenantId.founding(), 1);
    await firstEntered.promise;
    for (let sequence: number = 2; sequence <= 100; sequence += 1) {
      emit(store, TenantId.founding(), sequence);
    }
    releaseFirst.resolve();
    await latestDelivered.promise;
    expect(delivered).toEqual([1, 100]);
  } finally {
    releaseFirst.resolve();
    await store.close();
  }
});
