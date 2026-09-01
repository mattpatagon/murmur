import { expect, test } from "bun:test";

import type { TimeSource } from "../src/http/http-capacity.js";
import {
  cleanupObservabilityStartup,
  cleanupServerStartup,
  cleanupStoreStartup,
  type ForceStoppable,
  shutdownHttpResources,
} from "../src/http/http-server-resources.js";
import {
  cleanupAfterFailure,
  closeResources,
  type ResourceCleanup,
} from "../src/http/resource-lifecycle.js";
import {
  type ResponseFinishReason,
  responseWithDeadline,
  responseWithFinish,
  trackedResponse,
} from "../src/http/response-lifecycle.js";
import type {
  HttpObservability,
  RequestObservation,
} from "../src/observability/request-observation.js";
import type { LogFields } from "../src/observability/structured-logger.js";

type Closeable = {
  close(): Promise<void>;
};

class DeadlineTimeSource implements TimeSource {
  public cancellations: number = 0;
  private wake: (() => void) | null = null;

  public fire(): void {
    const wake: (() => void) | null = this.wake;
    if (wake === null) throw new Error("No response deadline is scheduled");
    this.wake = null;
    wake();
  }

  public now(): number {
    return 0;
  }

  public schedule(_milliseconds: number, wake: () => void): () => void {
    if (this.wake !== null) throw new Error("A response deadline is already scheduled");
    this.wake = wake;
    return (): void => {
      this.cancellations += 1;
      this.wake = null;
    };
  }
}

function closeable(events: string[], name: string, failure: Error | null = null): Closeable {
  return {
    close: async (): Promise<void> => {
      events.push(name);
      if (failure !== null) throw failure;
    },
  };
}

function stoppable(events: string[], name: string): ForceStoppable {
  return {
    stop: async (closeActiveConnections: boolean): Promise<void> => {
      events.push(`${name}:${String(closeActiveConnections)}`);
    },
  };
}

function observability(events: string[]): HttpObservability {
  return {
    info: (_event: string, _fields: LogFields): void => {},
    observe: (_request: Request): RequestObservation => {
      throw new Error("The cleanup test must not observe a request");
    },
    shutdown: async (): Promise<void> => {
      events.push("telemetry");
    },
  };
}

test("resource cleanup continues after failure and redacts logged credentials", async (): Promise<void> => {
  const events: string[] = [];
  const logs: string[] = [];
  const originalConsoleError: typeof console.error = console.error;
  const sentinel: string = "RESOURCE_DATABASE_PASSWORD";
  const databaseUrl: URL = new URL("postgresql://database.example/murmur");
  databaseUrl.username = "murmur";
  databaseUrl.password = sentinel;
  console.error = (...values: unknown[]): void => {
    logs.push(values.map(String).join(" "));
  };
  try {
    const cleanups: ResourceCleanup[] = [
      {
        close: async (): Promise<void> => {
          events.push("first");
        },
        context: "first cleanup",
      },
      {
        close: async (): Promise<void> => {
          events.push("second");
          throw new Error(`failed at ${databaseUrl.toString()}`);
        },
        context: "second cleanup",
      },
      {
        close: async (): Promise<void> => {
          events.push("third");
        },
        context: "third cleanup",
      },
    ];
    await expect(closeResources(cleanups)).rejects.toThrow(
      "Murmur resource shutdown failed in 1 step(s)",
    );
  } finally {
    console.error = originalConsoleError;
  }
  expect(events).toEqual(["first", "second", "third"]);
  expect(logs.join("\n")).toContain('"event":"operation.failed"');
  expect(logs.join("\n")).toContain('"context":"second cleanup"');
  expect(logs.join("\n")).not.toContain("database.example");
  expect(logs.join("\n")).not.toContain(sentinel);
});

test("startup cleanup suppresses secondary failures after logging them", async (): Promise<void> => {
  const originalConsoleError: typeof console.error = console.error;
  console.error = (_value: unknown): void => {};
  try {
    await cleanupAfterFailure([
      {
        close: async (): Promise<void> => {
          throw new Error("secondary cleanup failure");
        },
        context: "secondary cleanup",
      },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("HTTP startup and shutdown helpers close every resource in deterministic order", async (): Promise<void> => {
  const storeEvents: string[] = [];
  await cleanupStoreStartup(closeable(storeEvents, "store"));
  expect(storeEvents).toEqual(["store"]);

  const observabilityEvents: string[] = [];
  await cleanupObservabilityStartup(
    closeable(observabilityEvents, "authenticator"),
    closeable(observabilityEvents, "store"),
  );
  expect(observabilityEvents).toEqual(["authenticator", "store"]);

  const bindEvents: string[] = [];
  await cleanupServerStartup(
    closeable(bindEvents, "authenticator"),
    closeable(bindEvents, "store"),
    observability(bindEvents),
    null,
  );
  expect(bindEvents).toEqual(["authenticator", "store", "telemetry"]);

  const boundEvents: string[] = [];
  await cleanupServerStartup(
    closeable(boundEvents, "authenticator"),
    closeable(boundEvents, "store"),
    observability(boundEvents),
    stoppable(boundEvents, "server"),
  );
  expect(boundEvents).toEqual(["server:true", "authenticator", "store", "telemetry"]);

  const shutdownEvents: string[] = [];
  await shutdownHttpResources(
    stoppable(shutdownEvents, "server"),
    async (): Promise<void> => {
      shutdownEvents.push("sessions");
    },
    closeable(shutdownEvents, "authenticator"),
    closeable(shutdownEvents, "store"),
    observability(shutdownEvents),
  );
  expect(shutdownEvents).toEqual([
    "server:true",
    "sessions",
    "authenticator",
    "store",
    "telemetry",
  ]);
});

test("response lifecycle finishes bodyless, cancelled, and failed streams exactly once", async (): Promise<void> => {
  const bodylessFinishes: ResponseFinishReason[] = [];
  const bodyless: Response = responseWithFinish(
    new Response(null, { status: 204 }),
    (reason: ResponseFinishReason): void => {
      bodylessFinishes.push(reason);
    },
  );
  expect(bodyless.status).toBe(204);
  expect(bodylessFinishes).toEqual(["bodyless"]);

  const cancelledFinishes: ResponseFinishReason[] = [];
  const cancelledStream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start: (_controller: ReadableStreamDefaultController<Uint8Array>): void => {},
  });
  const cancelled: Response = responseWithFinish(
    new Response(cancelledStream),
    (reason: ResponseFinishReason): void => {
      cancelledFinishes.push(reason);
    },
  );
  if (cancelled.body === null) throw new Error("The cancellation stream body is missing");
  await cancelled.body.cancel("peer disconnected");
  await cancelled.body.cancel("duplicate cancellation");
  expect(cancelledFinishes).toEqual(["cancelled"]);

  const failedFinishes: ResponseFinishReason[] = [];
  const failure: Error = new Error("stream failed");
  const failedStream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      controller.error(failure);
    },
  });
  const failed: Response = responseWithFinish(
    new Response(failedStream),
    (reason: ResponseFinishReason): void => {
      failedFinishes.push(reason);
    },
  );
  await expect(failed.text()).rejects.toBe(failure);
  expect(failedFinishes).toEqual(["failed"]);

  const counter: { activeResponses: number } = { activeResponses: 0 };
  const untracked: Response = trackedResponse(new Response(null, { status: 204 }), counter);
  expect(untracked.status).toBe(204);
  expect(counter.activeResponses).toBe(0);
});

test("response deadlines close streams and cancel lifecycle resources exactly once", async (): Promise<void> => {
  const time: DeadlineTimeSource = new DeadlineTimeSource();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let deadlines: number = 0;
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start: (streamController: ReadableStreamDefaultController<Uint8Array>): void => {
      controller = streamController;
    },
  });
  const response: Response = responseWithDeadline(new Response(source), 25, time, (): void => {
    deadlines += 1;
    const activeController: ReadableStreamDefaultController<Uint8Array> | null = controller;
    if (activeController === null) throw new Error("The deadline stream controller is missing");
    activeController.close();
  });

  time.fire();
  expect(await response.text()).toBe("");
  expect(deadlines).toBe(1);
  expect(time.cancellations).toBe(1);

  const cancelledTime: DeadlineTimeSource = new DeadlineTimeSource();
  let cancelledDeadlines: number = 0;
  const cancelledSource: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start: (_controller: ReadableStreamDefaultController<Uint8Array>): void => {},
  });
  const cancelled: Response = responseWithDeadline(
    new Response(cancelledSource),
    25,
    cancelledTime,
    (): void => {
      cancelledDeadlines += 1;
    },
  );
  if (cancelled.body === null) throw new Error("The deadline cancellation body is missing");
  await cancelled.body.cancel("peer disconnected");
  expect(cancelledDeadlines).toBe(0);
  expect(cancelledTime.cancellations).toBe(1);

  const failedTime: DeadlineTimeSource = new DeadlineTimeSource();
  const failure: Error = new Error("deadline source failed");
  const failedSource: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull: (streamController: ReadableStreamDefaultController<Uint8Array>): void => {
      streamController.error(failure);
    },
  });
  const failed: Response = responseWithDeadline(
    new Response(failedSource),
    25,
    failedTime,
    (): void => {},
  );
  await expect(failed.text()).rejects.toBe(failure);
  expect(failedTime.cancellations).toBe(1);
});
