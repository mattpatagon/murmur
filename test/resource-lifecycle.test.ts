import { expect, test } from "bun:test";

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
import { responseWithFinish, trackedResponse } from "../src/http/response-lifecycle.js";
import type {
  HttpObservability,
  RequestObservation,
} from "../src/observability/request-observation.js";
import type { LogFields } from "../src/observability/structured-logger.js";

type Closeable = {
  close(): Promise<void>;
};

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
  let bodylessFinishes: number = 0;
  const bodyless: Response = responseWithFinish(new Response(null, { status: 204 }), (): void => {
    bodylessFinishes += 1;
  });
  expect(bodyless.status).toBe(204);
  expect(bodylessFinishes).toBe(1);

  let failedFinishes: number = 0;
  const failure: Error = new Error("stream failed");
  const failedStream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      controller.error(failure);
    },
  });
  const failed: Response = responseWithFinish(new Response(failedStream), (): void => {
    failedFinishes += 1;
  });
  await expect(failed.text()).rejects.toBe(failure);
  expect(failedFinishes).toBe(1);

  const counter: { activeResponses: number } = { activeResponses: 0 };
  const untracked: Response = trackedResponse(new Response(null, { status: 204 }), counter);
  expect(untracked.status).toBe(204);
  expect(counter.activeResponses).toBe(0);
});
