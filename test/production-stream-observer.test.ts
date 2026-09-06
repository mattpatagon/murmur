import { expect, test } from "bun:test";

import {
  PRODUCTION_STREAM_POLICY,
  type ProductionStreamClock,
  type ProductionStreamPolicy,
  type ProductionStreamSession,
  type ProductionStreamSnapshot,
} from "../scripts/lib/production-stream-contracts.js";
import { observeProductionStream } from "../scripts/lib/production-stream-observer.js";
import {
  PRODUCTION_STREAM_TOTAL_DEADLINE_MS,
  PRODUCTION_STREAM_WORK_DEADLINE_MS,
} from "../scripts/verify-production-stream.js";

const POLICY: ProductionStreamPolicy = {
  minimumWindowMs: 55,
  maximumWindowMs: 60,
  earliestReconnectMs: 49.5,
  healthIntervalMs: 10,
  pollIntervalMs: 1,
  requestTimeoutMs: 1_000,
};

type Fixture = {
  readonly clock: ProductionStreamClock;
  readonly signal: AbortSignal;
  readonly session: ProductionStreamSession;
  readonly health: () => Promise<void>;
  readonly events: string[];
};

function fixture(
  options: {
    readonly reconnect?: number | undefined;
    readonly invalidAt?: number | undefined;
    readonly changedHash?: boolean | undefined;
    readonly initializations?: number | undefined;
    readonly healthFailure?: boolean | undefined;
    readonly deliveryFailure?: boolean | undefined;
    readonly closeFailure?: boolean | undefined;
    readonly abortAt?: number | undefined;
    readonly duplicateRequestId?: boolean | undefined;
  } = {},
): Fixture {
  let now: number = 0;
  const events: string[] = [];
  const controller: AbortController = new AbortController();
  const clock: ProductionStreamClock = {
    now: (): number => now,
    timestamp: (): string => new Date(now).toISOString(),
    sleep: async (milliseconds: number, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      now += milliseconds;
      if (now >= (options.abortAt ?? Number.POSITIVE_INFINITY)) controller.abort();
    },
  };
  const snapshot: () => ProductionStreamSnapshot = (): ProductionStreamSnapshot => {
    const reconnected: boolean = now >= (options.reconnect ?? 50);
    return {
      initializationAttempts: options.initializations ?? 1,
      successfulInitializations: options.initializations ?? 1,
      successfulGets: reconnected ? 2 : 1,
      sessionHash: options.changedHash === true && reconnected ? "changed" : "same-hash",
      firstGetAt: 0,
      firstGetTimestamp: new Date(0).toISOString(),
      reconnectAt: reconnected ? (options.reconnect ?? 50) : null,
      reconnectTimestamp: reconnected ? new Date(options.reconnect ?? 50).toISOString() : null,
      initialRequestId: "10000000-0000-4000-8000-000000000001",
      replacementRequestId: !reconnected
        ? null
        : options.duplicateRequestId === true
          ? "10000000-0000-4000-8000-000000000001"
          : "10000000-0000-4000-8000-000000000002",
      invalid: now >= (options.invalidAt ?? Number.POSITIVE_INFINITY),
    };
  };
  const session: ProductionStreamSession = {
    start: async (): Promise<void> => {
      events.push("start");
    },
    subscribe: async (): Promise<void> => {
      events.push("subscribe");
    },
    keepAlive: async (): Promise<void> => {
      events.push("ping");
    },
    snapshot,
    proveDelivery: async (): Promise<void> => {
      expect(now).toBeGreaterThanOrEqual(55);
      expect(snapshot().successfulGets).toBe(2);
      events.push("notification-and-inbox");
      if (options.deliveryFailure === true)
        throw new Error("private payload must not become evidence");
    },
    close: async (): Promise<void> => {
      events.push("close");
      if (options.closeFailure === true) throw new Error("private close details");
    },
  };
  return {
    clock,
    signal: controller.signal,
    session,
    events,
    health: async (): Promise<void> => {
      events.push("health");
      if (options.healthFailure === true && now >= 40) throw new Error("wrong deployed SHA");
    },
  };
}

test("production entry retains a fixed 55-minute window within its 60-minute total budget", (): void => {
  expect(PRODUCTION_STREAM_POLICY.minimumWindowMs).toBe(55 * 60_000);
  expect(PRODUCTION_STREAM_TOTAL_DEADLINE_MS).toBe(60 * 60_000);
  expect(PRODUCTION_STREAM_WORK_DEADLINE_MS).toBe(57 * 60_000);
});

test("injected clock proves full elapsed window, periodic health, reconnect delivery and deliberate close", async (): Promise<void> => {
  const value: Fixture = fixture();
  const result: Awaited<ReturnType<typeof observeProductionStream>> = await observeProductionStream(
    value.session,
    value.health,
    value.clock,
    POLICY,
    value.signal,
  );
  expect(result.observed_ms).toBe(55);
  expect(result.health_checks).toBe(7);
  expect(result.successful_sse_gets).toBe(2);
  expect(result.initialization_count).toBe(1);
  expect(result.real_window_passed).toBe(true);
  expect(value.events.slice(-4)).toEqual(["notification-and-inbox", "health", "ping", "close"]);
});

for (const options of [
  { reconnect: 61 },
  { reconnect: 10 },
  { invalidAt: 20 },
  { changedHash: true },
  { initializations: 2 },
  { healthFailure: true },
  { deliveryFailure: true },
  { closeFailure: true },
  { abortAt: 25 },
  { duplicateRequestId: true },
]) {
  test(`observer fails closed for ${JSON.stringify(options)}`, async (): Promise<void> => {
    const value: Fixture = fixture(options);
    await expect(
      observeProductionStream(value.session, value.health, value.clock, POLICY, value.signal),
    ).rejects.toThrow();
    expect(value.clock.now()).toBeLessThanOrEqual(61);
  });
}
