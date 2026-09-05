import { expect, test } from "bun:test";

import {
  MAX_RESOURCE_MUTATIONS_PER_SESSION,
  ResourceMutationQueue,
} from "../src/mcp/resource-mutation-queue.js";

type Barrier = { readonly promise: Promise<void>; readonly resolve: () => void };

function observed<T>(operation: Promise<T>): Promise<T | unknown> {
  return operation.catch((error: unknown): unknown => error);
}

test("active cancellation retains its execution slot while repeated queued cancellations release theirs", async (): Promise<void> => {
  const queue: ResourceMutationQueue = new ResourceMutationQueue();
  const entered: Barrier = Promise.withResolvers<void>();
  const released: Barrier = Promise.withResolvers<void>();
  const activeCancellation: AbortController = new AbortController();
  let executed: number = 0;
  const first: Promise<unknown> = observed(
    queue.run(async (): Promise<void> => {
      executed += 1;
      entered.resolve();
      await released.promise;
    }, activeCancellation.signal),
  );
  await entered.promise;
  activeCancellation.abort();
  try {
    for (let index: number = 0; index < 1_000; index += 1) {
      const cancellation: AbortController = new AbortController();
      const canceled: Promise<unknown> = observed(
        queue.run(async (): Promise<void> => {
          executed += 1;
        }, cancellation.signal),
      );
      cancellation.abort();
      await canceled;
      expect(queue.outstanding).toBe(1);
    }
    expect(executed).toBe(1);
  } finally {
    released.resolve();
    await queue.close();
  }
  expect(await first).toBeInstanceOf(Error);
  expect(queue.outstanding).toBe(0);
});

test("active cancellation keeps the server-handler promise pending until its action settles", async (): Promise<void> => {
  const queue: ResourceMutationQueue = new ResourceMutationQueue();
  const entered: Barrier = Promise.withResolvers<void>();
  const released: Barrier = Promise.withResolvers<void>();
  const activeCancellation: AbortController = new AbortController();
  const queuedCancellation: AbortController = new AbortController();
  let activeSettled: boolean = false;
  const active: Promise<unknown> = observed(
    queue.run(async (): Promise<string> => {
      entered.resolve();
      await released.promise;
      return "completed underlying action";
    }, activeCancellation.signal),
  ).then((result: unknown): unknown => {
    activeSettled = true;
    return result;
  });
  await entered.promise;
  let queuedRan: boolean = false;
  const queued: Promise<unknown> = observed(
    queue.run(async (): Promise<void> => {
      queuedRan = true;
    }, queuedCancellation.signal),
  );
  activeCancellation.abort();
  queuedCancellation.abort();
  try {
    expect(await queued).toHaveProperty(
      "message",
      "MCP error -32600: Inbox mutation request was canceled.",
    );
    expect(queuedRan).toBe(false);
    expect(queue.outstanding).toBe(1);
    expect(activeSettled).toBe(false);
    released.resolve();
    expect(await active).toHaveProperty(
      "message",
      "MCP error -32600: Inbox mutation request was canceled.",
    );
  } finally {
    released.resolve();
    await active;
    await queue.close();
  }
  expect(queue.outstanding).toBe(0);
});

test("all sixteen slots are usable and admitted work preserves FIFO across failures", async (): Promise<void> => {
  const queue: ResourceMutationQueue = new ResourceMutationQueue();
  const entered: Barrier = Promise.withResolvers<void>();
  const released: Barrier = Promise.withResolvers<void>();
  const order: number[] = [];
  const requests: Promise<unknown>[] = [];
  requests.push(
    observed(
      queue.run(async (): Promise<number> => {
        order.push(0);
        entered.resolve();
        await released.promise;
        return 0;
      }, new AbortController().signal),
    ),
  );
  await entered.promise;
  for (let index: number = 1; index < MAX_RESOURCE_MUTATIONS_PER_SESSION; index += 1) {
    requests.push(
      observed(
        queue.run(async (): Promise<number> => {
          order.push(index);
          if (index === 3) throw new Error("Expected task failure");
          return index;
        }, new AbortController().signal),
      ),
    );
  }
  try {
    expect(queue.outstanding).toBe(16);
    await expect(
      queue.run(async (): Promise<void> => {}, new AbortController().signal),
    ).rejects.toThrow("Inbox mutation capacity reached (16 per session).");
    released.resolve();
    const results: unknown[] = await Promise.all(requests);
    expect(results[0]).toBe(0);
    expect(results[3]).toBeInstanceOf(Error);
    expect(results[15]).toBe(15);
    expect(order).toEqual(
      Array.from({ length: 16 }, (_value: unknown, index: number): number => index),
    );
  } finally {
    released.resolve();
    await queue.close();
  }
  expect(queue.outstanding).toBe(0);
});

test("closing rejects queued mutations immediately but waits for occupied work", async (): Promise<void> => {
  const queue: ResourceMutationQueue = new ResourceMutationQueue();
  const entered: Barrier = Promise.withResolvers<void>();
  const released: Barrier = Promise.withResolvers<void>();
  const active: Promise<unknown> = observed(
    queue.run(async (): Promise<void> => {
      entered.resolve();
      await released.promise;
    }, new AbortController().signal),
  );
  await entered.promise;
  let queuedRan: boolean = false;
  const queued: Promise<unknown> = observed(
    queue.run(async (): Promise<void> => {
      queuedRan = true;
    }, new AbortController().signal),
  );
  let closed: boolean = false;
  const firstClose: Promise<void> = queue.close();
  const closing: Promise<void> = firstClose.then((): void => {
    closed = true;
  });
  expect(queue.close()).toBe(firstClose);
  expect(await queued).toHaveProperty("message", "MCP error -32600: Session is closed.");
  expect(closed).toBe(false);
  expect(queuedRan).toBe(false);
  expect(queue.outstanding).toBe(1);
  released.resolve();
  await active;
  await closing;
  expect(queue.outstanding).toBe(0);
  await expect(
    queue.run(async (): Promise<void> => {}, new AbortController().signal),
  ).rejects.toThrow("Session is closed.");
});

test("already canceled and closed-before-dispatch mutations never invoke their action", async (): Promise<void> => {
  const queue: ResourceMutationQueue = new ResourceMutationQueue();
  const cancellation: AbortController = new AbortController();
  cancellation.abort();
  let calls: number = 0;
  const action: () => Promise<void> = async (): Promise<void> => {
    calls += 1;
  };
  await expect(queue.run(action, cancellation.signal)).rejects.toThrow("was canceled");
  expect(queue.outstanding).toBe(0);
  const pending: Promise<unknown> = observed(queue.run(action, new AbortController().signal));
  await queue.close();
  expect(await pending).toHaveProperty("message", "MCP error -32600: Session is closed.");
  expect(calls).toBe(0);
  expect(queue.outstanding).toBe(0);
});
