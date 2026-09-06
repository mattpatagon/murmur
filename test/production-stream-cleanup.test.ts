import { expect, test } from "bun:test";

import {
  type ProductionStreamCleanupActions,
  type ProductionStreamCleanupClock,
  type ProductionStreamCleanupScope,
  productionStreamCleanup,
} from "../scripts/lib/production-stream-cleanup.js";
import type { ProductionStreamCleanup } from "../scripts/lib/production-stream-contracts.js";

function actions(events: string[], failing: string | null = null): ProductionStreamCleanupActions {
  const action: (name: string) => () => Promise<boolean> =
    (name: string): (() => Promise<boolean>) =>
    async (): Promise<boolean> => {
      events.push(name);
      if (name === failing) throw new Error("private failure details");
      return true;
    };
  return {
    revokeWorker: action("revoke-worker"),
    verifyWorker: action("verify-worker"),
    revokeAdministrator: action("revoke-admin"),
    verifyAdministrator: action("verify-admin"),
    suspendTenant: action("suspend"),
    closeConnections: action("close"),
  };
}

const ORDER: readonly string[] = [
  "revoke-worker",
  "verify-worker",
  "revoke-admin",
  "verify-admin",
  "suspend",
  "close",
];

test("cleanup verifies each target credential before suspension and is concurrent-call idempotent", async (): Promise<void> => {
  const events: string[] = [];
  const cleanup: () => Promise<ProductionStreamCleanup> = productionStreamCleanup(actions(events));
  const first: Promise<ProductionStreamCleanup> = cleanup();
  expect(cleanup()).toBe(first);
  const result: ProductionStreamCleanup = await first;
  expect(Object.values(result).every((value: boolean): boolean => value)).toBe(true);
  expect(events).toEqual(Array.from(ORDER));
  expect(cleanup()).toBe(first);
});

for (const stage of ORDER) {
  test(`cleanup continues all remaining stages after ${stage} failure`, async (): Promise<void> => {
    const events: string[] = [];
    const result: ProductionStreamCleanup = await productionStreamCleanup(actions(events, stage))();
    expect(events).toEqual(Array.from(ORDER));
    if (stage === "verify-worker") expect(result.worker_unauthorized).toBe(false);
    if (stage === "verify-admin") expect(result.administrator_unauthorized).toBe(false);
    if (stage === "suspend") expect(result.tenant_suspended).toBe(false);
    if (stage === "close") expect(result.connections_closed).toBe(false);
    if (stage === "revoke-worker") expect(result.worker_revoked).toBe(true);
    if (stage === "revoke-admin") expect(result.administrator_revoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
  });
}

class ManualClock implements ProductionStreamCleanupClock {
  public current: number = 0;
  private nextId: number = 0;
  private readonly tasks: Map<number, { readonly at: number; readonly run: () => void }> =
    new Map();
  public now(): number {
    return this.current;
  }
  public schedule(milliseconds: number, run: () => void): () => void {
    this.nextId += 1;
    const id: number = this.nextId;
    this.tasks.set(id, { at: this.current + milliseconds, run });
    return (): void => {
      this.tasks.delete(id);
    };
  }
  public advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const [id, task] of this.tasks) {
      if (task.at > this.current) continue;
      this.tasks.delete(id);
      task.run();
    }
  }
}

async function flush(): Promise<void> {
  for (let index: number = 0; index < 20; index += 1) await Promise.resolve();
}

test("cleanup timeout aborts the actual action, waits for settlement, and then continues", async (): Promise<void> => {
  const clock: ManualClock = new ManualClock();
  const events: string[] = [];
  let aborted: boolean = false;
  const cleanup: () => Promise<ProductionStreamCleanup> = productionStreamCleanup(
    {
      ...actions(events),
      revokeWorker: async (scope: ProductionStreamCleanupScope): Promise<boolean> => {
        events.push("revoke-worker");
        expect(scope.deadline).toBe(5);
        return await new Promise<boolean>(
          (_resolve: (value: boolean) => void, reject: (error: Error) => void): void => {
            scope.signal.addEventListener(
              "abort",
              (): void => {
                aborted = true;
                reject(new Error("aborted actual request"));
              },
              { once: true },
            );
          },
        );
      },
    },
    clock,
    { totalMs: 30, closeReserveMs: 10, stepMs: 5, settleMs: 2 },
  );
  const result: Promise<ProductionStreamCleanup> = cleanup();
  await flush();
  clock.advance(5);
  await flush();
  const completed: ProductionStreamCleanup = await result;
  expect(aborted).toBe(true);
  expect(events).toEqual(Array.from(ORDER));
  expect(completed.connections_closed).toBe(true);
});

test("unsettled aborted mutation blocks later mutations but still closes connections without claiming settlement", async (): Promise<void> => {
  const clock: ManualClock = new ManualClock();
  const events: string[] = [];
  let complete: (value: boolean) => void = (_value: boolean): void => {};
  const pending: Promise<boolean> = new Promise<boolean>(
    (resolve: (value: boolean) => void): void => {
      complete = resolve;
    },
  );
  const cleanup: () => Promise<ProductionStreamCleanup> = productionStreamCleanup(
    {
      ...actions(events),
      revokeWorker: async (): Promise<boolean> => {
        events.push("revoke-worker");
        return await pending;
      },
    },
    clock,
    { totalMs: 30, closeReserveMs: 10, stepMs: 5, settleMs: 2 },
  );
  const result: Promise<ProductionStreamCleanup> = cleanup();
  await flush();
  clock.advance(5);
  await flush();
  clock.advance(2);
  await flush();
  const completed: ProductionStreamCleanup = await result;
  expect(events).toEqual(["revoke-worker", "close"]);
  expect(completed.connections_closed).toBe(false);
  expect(completed.tenant_suspended).toBe(false);
  complete(true);
  await pending;
  expect(cleanup()).toBe(result);
  expect((await cleanup()).worker_revoked).toBe(false);
});

test("exhausted mutation budget starts no later operation and preserves its final close allowance", async (): Promise<void> => {
  const clock: ManualClock = new ManualClock();
  const events: string[] = [];
  const result: ProductionStreamCleanup = await productionStreamCleanup(
    {
      ...actions(events),
      revokeWorker: async (): Promise<boolean> => {
        events.push("revoke-worker");
        clock.current = 20;
        return true;
      },
    },
    clock,
    { totalMs: 30, closeReserveMs: 10, stepMs: 5, settleMs: 2 },
  )();
  expect(events).toEqual(["revoke-worker", "close"]);
  expect(result.worker_unauthorized).toBe(false);
  expect(result.connections_closed).toBe(true);
});
