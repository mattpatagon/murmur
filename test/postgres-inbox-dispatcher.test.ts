import { expect, test } from "bun:test";

import { AgentId, Sequence, TenantId } from "../src/domain/value-objects.js";
import {
  type DispatcherSubscription,
  type InboxDispatcherOptions,
  type InboxDispatcherTimeSource,
  PostgresInboxDispatcher,
} from "../src/storage/postgres-inbox-dispatcher.js";

type Signal<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };
type Timer = { readonly deadline: number; readonly wake: () => void };

class ManualTime implements InboxDispatcherTimeSource {
  private current: number = 0;
  private readonly timers: Set<Timer> = new Set<Timer>();
  public now(): number {
    return this.current;
  }
  public schedule(milliseconds: number, wake: () => void): () => void {
    const timer: Timer = { deadline: this.current + milliseconds, wake };
    this.timers.add(timer);
    return (): void => {
      this.timers.delete(timer);
    };
  }
  public advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const timer of Array.from(this.timers)) {
      if (this.timers.has(timer) && timer.deadline <= this.current) {
        this.timers.delete(timer);
        timer.wake();
      }
    }
  }
  public pending(): number {
    return this.timers.size;
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let turn: number = 0; turn < 20; turn += 1) await Promise.resolve();
}

function dispatcher(
  time: ManualTime,
  overrides: Partial<InboxDispatcherOptions> = {},
): PostgresInboxDispatcher {
  return new PostgresInboxDispatcher({
    readVersion: async (): Promise<Sequence> => Sequence.zero(),
    reportError: (): void => {},
    time,
    ...overrides,
  });
}

function subscribe(
  dispatch: PostgresInboxDispatcher,
  tenant: TenantId,
  id: string,
): DispatcherSubscription {
  return dispatch.subscribe(
    tenant,
    AgentId.parse(id),
    Sequence.zero(),
    async (): Promise<void> => {},
  );
}

test("dispatcher bounds global, tenant, and inbox subscriptions and returns released capacity", (): void => {
  const time: ManualTime = new ManualTime();
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    maxSubscriptions: 3,
    maxSubscriptionsPerTenant: 2,
    maxSubscriptionsPerInbox: 1,
  });
  const first: TenantId = TenantId.generate();
  const second: TenantId = TenantId.generate();
  try {
    const released: DispatcherSubscription = subscribe(dispatch, first, "one");
    expect((): DispatcherSubscription => subscribe(dispatch, first, "one")).toThrow(
      "capacity reached",
    );
    subscribe(dispatch, first, "two");
    expect((): DispatcherSubscription => subscribe(dispatch, first, "three")).toThrow(
      "capacity reached",
    );
    subscribe(dispatch, second, "one");
    expect((): DispatcherSubscription => subscribe(dispatch, TenantId.generate(), "one")).toThrow(
      "capacity reached",
    );
    released.close();
    released.close();
    subscribe(dispatch, first, "three");
    expect(dispatch.snapshot().occupiedSubscriptions).toBe(3);
  } finally {
    dispatch.close();
  }
  expect(dispatch.snapshot().occupiedSubscriptions).toBe(0);
  expect(time.pending()).toBe(0);
});

test("dispatcher capacity accommodates ten subscriptions for each of the default thousand sessions", (): void => {
  const dispatch: PostgresInboxDispatcher = dispatcher(new ManualTime());
  try {
    for (let tenant: number = 0; tenant < 10; tenant += 1) {
      const tenantId: TenantId = TenantId.generate();
      for (let subscription: number = 0; subscription < 1_000; subscription += 1) {
        subscribe(dispatch, tenantId, `agent-${subscription}`);
      }
    }
    expect(dispatch.snapshot().occupiedSubscriptions).toBe(10_000);
  } finally {
    dispatch.close();
  }
  expect(dispatch.snapshot().occupiedSubscriptions).toBe(0);
});

test("a handler deadline cannot free an unresolved slot through unsubscribe and resubscribe churn", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const errors: unknown[] = [];
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    handlerTimeoutMs: 5,
    maxSubscriptions: 2,
    maxSubscriptionsPerTenant: 1,
    reportError: (error: unknown): void => {
      errors.push(error);
    },
  });
  const tenant: TenantId = TenantId.generate();
  const blocked: Signal<void> = Promise.withResolvers<void>();
  let invocations: number = 0;
  const subscription: DispatcherSubscription = dispatch.subscribe(
    tenant,
    AgentId.parse("blocked"),
    Sequence.zero(),
    async (): Promise<void> => {
      invocations += 1;
      await blocked.promise;
    },
  );
  try {
    const initial: Promise<string> = subscription.initialize(Sequence.parse(1)).then(
      (): string => "delivered",
      (): string => "rejected",
    );
    await drainMicrotasks();
    time.advance(4);
    expect(errors).toHaveLength(0);
    time.advance(1);
    expect(await initial).toBe("rejected");
    for (let sequence: number = 2; sequence <= 100; sequence += 1) {
      dispatch.publish(tenant, AgentId.parse("blocked"), Sequence.parse(sequence));
    }
    subscription.close();
    expect(dispatch.snapshot()).toMatchObject({ activeInboxes: 0, occupiedSubscriptions: 1 });
    for (let attempt: number = 0; attempt < 100; attempt += 1) {
      expect((): DispatcherSubscription => subscribe(dispatch, tenant, `retry-${attempt}`)).toThrow(
        "capacity reached",
      );
    }
    const healthy: DispatcherSubscription = subscribe(dispatch, TenantId.generate(), "healthy");
    await healthy.initialize(Sequence.parse(1));
    expect(invocations).toBe(1);
    expect(errors).toHaveLength(1);
    expect(time.pending()).toBe(0);
    blocked.resolve();
    await drainMicrotasks();
    subscribe(dispatch, tenant, "replacement");
    expect(dispatch.snapshot().occupiedSubscriptions).toBe(2);
  } finally {
    blocked.resolve();
    dispatch.close();
    await drainMicrotasks();
  }
  expect(dispatch.snapshot().occupiedSubscriptions).toBe(0);
});

test("duplicate and stale notifications cannot regress sequence or retry a failed handler indefinitely", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const errors: unknown[] = [];
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    reportError: (error: unknown): void => {
      errors.push(error);
    },
  });
  const tenant: TenantId = TenantId.generate();
  const agent: AgentId = AgentId.parse("sequence");
  const calls: number[] = [];
  const subscription: DispatcherSubscription = dispatch.subscribe(
    tenant,
    agent,
    Sequence.parse(5),
    async (sequence: Sequence): Promise<void> => {
      calls.push(sequence.value);
      if (sequence.value === 10) throw new Error("Test handler failure");
    },
  );
  try {
    await subscription.initialize(Sequence.parse(4));
    await expect(subscription.initialize(Sequence.parse(10))).rejects.toThrow("delivery failed");
    for (const value of [0, 5, 8, 10, 10]) dispatch.publish(tenant, agent, Sequence.parse(value));
    await drainMicrotasks();
    expect(calls).toEqual([10]);
    expect(errors).toHaveLength(1);
    await subscription.initialize(Sequence.parse(11));
    expect(calls).toEqual([10, 11]);
    expect(time.pending()).toBe(0);
  } finally {
    dispatch.close();
  }
});

test("unsubscribed notification floods retain no workspace state", (): void => {
  const dispatch: PostgresInboxDispatcher = dispatcher(new ManualTime());
  const tenant: TenantId = TenantId.generate();
  for (let index: number = 0; index < 25_000; index += 1) {
    dispatch.publish(tenant, AgentId.parse(`absent-${index}`), Sequence.parse(index));
  }
  expect(dispatch.snapshot()).toEqual({
    activeInboxes: 0,
    occupiedSubscriptions: 0,
    catchUpRunning: false,
  });
  dispatch.close();
  dispatch.close();
  dispatch.publish(tenant, AgentId.parse("closed"), Sequence.parse(1));
  expect((): DispatcherSubscription => subscribe(dispatch, tenant, "closed")).toThrow("closed");
});

test("reconnect signals coalesce while one durable lookup is pending and do not block other delivery", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const blocked: Signal<Sequence> = Promise.withResolvers<Sequence>();
  const reads: string[] = [];
  const errors: unknown[] = [];
  const finished: Signal<void> = Promise.withResolvers<void>();
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    catchUpTimeoutMs: 5,
    readVersion: async (tenant: TenantId, agent: AgentId): Promise<Sequence> => {
      reads.push(`${tenant.value}:${agent.value}`);
      if (reads.length === 1) return await blocked.promise;
      if (reads.length === 4) finished.resolve();
      return Sequence.parse(10 + reads.length);
    },
    reportError: (error: unknown): void => {
      errors.push(error);
    },
  });
  const tenant: TenantId = TenantId.generate();
  subscribe(dispatch, tenant, "one");
  subscribe(dispatch, tenant, "one");
  const healthy: DispatcherSubscription = subscribe(dispatch, TenantId.generate(), "two");
  try {
    dispatch.requestCatchUp();
    for (let retry: number = 0; retry < 1_000; retry += 1) dispatch.requestCatchUp();
    expect(reads).toHaveLength(1);
    expect(time.pending()).toBe(1);
    time.advance(5);
    expect(errors).toHaveLength(1);
    expect(time.pending()).toBe(0);
    await healthy.initialize(Sequence.parse(100));
    expect(reads).toHaveLength(1);
    blocked.resolve(Sequence.parse(9));
    await finished.promise;
    await drainMicrotasks();
    expect(reads).toHaveLength(4);
    expect(reads[0]).toBe(reads[2]);
    expect(reads[1]).toBe(reads[3]);
    expect(dispatch.snapshot().catchUpRunning).toBe(false);
    expect(time.pending()).toBe(0);
  } finally {
    blocked.resolve(Sequence.zero());
    dispatch.close();
  }
});

test("shutdown drops late catch-up and scheduled delivery without waiting for subscriber work", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const lookup: Signal<Sequence> = Promise.withResolvers<Sequence>();
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    readVersion: async (): Promise<Sequence> => await lookup.promise,
  });
  const tenant: TenantId = TenantId.generate();
  let delivered: number = 0;
  const subscription: DispatcherSubscription = dispatch.subscribe(
    tenant,
    AgentId.parse("closed"),
    Sequence.zero(),
    async (): Promise<void> => {
      delivered += 1;
    },
  );
  try {
    dispatch.requestCatchUp();
    dispatch.publish(tenant, AgentId.parse("closed"), Sequence.parse(1));
    dispatch.close();
    dispatch.close();
    dispatch.requestCatchUp();
    expect(time.pending()).toBe(0);
    await expect(subscription.initialize(Sequence.parse(2))).rejects.toThrow("closed");
    lookup.resolve(Sequence.parse(10));
    await drainMicrotasks();
    expect(delivered).toBe(0);
    expect(dispatch.snapshot()).toEqual({
      activeInboxes: 0,
      occupiedSubscriptions: 0,
      catchUpRunning: false,
    });
  } finally {
    lookup.resolve(Sequence.zero());
    dispatch.close();
  }
});

test("reconnect retries a failed hint after a successful durable read and survives lookup failure", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const errors: unknown[] = [];
  let lookupFails: boolean = true;
  let handlerFails: boolean = true;
  let delivered: number = 0;
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    readVersion: async (): Promise<Sequence> => {
      if (lookupFails) throw new Error("Lookup unavailable");
      return Sequence.parse(10);
    },
    reportError: (error: unknown): void => {
      errors.push(error);
    },
  });
  const subscription: DispatcherSubscription = dispatch.subscribe(
    TenantId.generate(),
    AgentId.parse("recover"),
    Sequence.zero(),
    async (): Promise<void> => {
      if (handlerFails) throw new Error("Handler unavailable");
      delivered += 1;
    },
  );
  try {
    await expect(subscription.initialize(Sequence.parse(10))).rejects.toThrow("delivery failed");
    dispatch.requestCatchUp();
    await drainMicrotasks();
    expect(errors).toHaveLength(2);
    lookupFails = false;
    handlerFails = false;
    dispatch.requestCatchUp();
    await drainMicrotasks();
    expect(delivered).toBe(1);
    expect(time.pending()).toBe(0);
  } finally {
    dispatch.close();
  }
});

test("late catch-up results cannot reach a replacement subscription for the same inbox", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const lookup: Signal<Sequence> = Promise.withResolvers<Sequence>();
  const dispatch: PostgresInboxDispatcher = dispatcher(time, {
    readVersion: async (): Promise<Sequence> => await lookup.promise,
  });
  const tenant: TenantId = TenantId.generate();
  const first: DispatcherSubscription = subscribe(dispatch, tenant, "replacement");
  let delivered: number = 0;
  try {
    dispatch.requestCatchUp();
    first.close();
    dispatch.subscribe(
      tenant,
      AgentId.parse("replacement"),
      Sequence.zero(),
      async (): Promise<void> => {
        delivered += 1;
      },
    );
    lookup.resolve(Sequence.parse(10));
    await drainMicrotasks();
    expect(delivered).toBe(0);
    expect(dispatch.snapshot().occupiedSubscriptions).toBe(1);
  } finally {
    lookup.resolve(Sequence.zero());
    dispatch.close();
  }
});

test("cleanup has a deterministic deadline and observes late failure without retaining more timers", async (): Promise<void> => {
  const time: ManualTime = new ManualTime();
  const dispatch: PostgresInboxDispatcher = dispatcher(time, { cleanupTimeoutMs: 5 });
  const completion: { readonly promise: Promise<void>; readonly reject: (error: unknown) => void } =
    Promise.withResolvers<void>();
  const cleanup: Promise<string> = dispatch
    .settleCleanup(async (): Promise<void> => await completion.promise)
    .then(
      (): string => "complete",
      (): string => "timeout",
    );
  time.advance(5);
  expect(await cleanup).toBe("timeout");
  completion.reject(new Error("Late cleanup failure"));
  await drainMicrotasks();
  await dispatch.settleCleanup(async (): Promise<void> => {});
  await expect(
    dispatch.settleCleanup(async (): Promise<void> => {
      throw new Error("Cleanup failed");
    }),
  ).rejects.toThrow("Cleanup failed");
  dispatch.close();
  expect(time.pending()).toBe(0);
});

test("invalid dispatcher limits fail before allocating subscriber state", (): void => {
  for (const maximum of [0, -1, Number.NaN, 16_385]) {
    expect(
      (): PostgresInboxDispatcher => dispatcher(new ManualTime(), { maxSubscriptions: maximum }),
    ).toThrow("bounds");
  }
});
