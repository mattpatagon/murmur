import { expect, test } from "bun:test";
import { runHttpProcess, type HttpProcessRuntime } from "../src/http/http-process.js";
import type { MurmurHttpServer } from "../src/http/http-server-contracts.js";

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferred(): Deferred {
  let resolvePromise: () => void = (): void => {
    throw new Error("Deferred was not initialized");
  };
  const promise: Promise<void> = new Promise<void>((resolve: () => void): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

type Harness = {
  readonly exitCodes: number[];
  readonly failed: Deferred;
  readonly failures: Array<{ readonly message: string; readonly error: unknown }>;
  readonly listeners: Map<string, () => void>;
  readonly ready: Deferred;
  readonly runtime: HttpProcessRuntime;
};

function harness(): Harness {
  const exitCodes: number[] = [];
  const failures: Array<{ readonly message: string; readonly error: unknown }> = [];
  const listeners: Map<string, () => void> = new Map<string, () => void>();
  const ready: Deferred = deferred();
  const failed: Deferred = deferred();
  return {
    exitCodes,
    failed,
    failures,
    listeners,
    ready,
    runtime: {
      once: (signal: "SIGINT" | "SIGTERM", listener: () => void): void => {
        expect(listeners.has(signal)).toBe(false);
        listeners.set(signal, listener);
        if (listeners.size === 2) ready.resolve();
      },
      reportFailure: (message: string, error: unknown): void => {
        failures.push({ message, error });
      },
      setExitCode: (code: number): void => {
        exitCodes.push(code);
        failed.resolve();
      },
    },
  };
}

function signal(state: Harness, name: "SIGINT" | "SIGTERM"): void {
  const listener: (() => void) | undefined = state.listeners.get(name);
  if (listener === undefined) throw new Error("Expected signal listener");
  listener();
}

function server(stop: () => Promise<void>): MurmurHttpServer {
  return {
    mcpUrl: new URL("http://127.0.0.1:12345/mcp"),
    port: 12345,
    registrationUrl: new URL("http://127.0.0.1:12345/v1/tenants"),
    stop,
  };
}

test("HTTP process installs signal handlers only after startup and stops once while cleanup is pending", async (): Promise<void> => {
  const state: Harness = harness();
  const startup: Deferred = deferred();
  const stopping: Deferred = deferred();
  const stopped: Deferred = deferred();
  let calls: number = 0;
  const instance: MurmurHttpServer = server(async (): Promise<void> => {
    calls += 1;
    stopping.resolve();
    await stopped.promise;
  });
  runHttpProcess(async (): Promise<MurmurHttpServer> => {
    await startup.promise;
    return instance;
  }, state.runtime);
  expect(state.listeners.size).toBe(0);
  startup.resolve();
  await state.ready.promise;
  signal(state, "SIGINT");
  signal(state, "SIGTERM");
  signal(state, "SIGINT");
  await stopping.promise;
  expect(calls).toBe(1);
  expect(state.failures).toEqual([]);
  expect(state.exitCodes).toEqual([]);
  stopped.resolve();
});

test("HTTP process reports rejected and synchronous startup failures without installing signal handlers", async (): Promise<void> => {
  for (const synchronous of [false, true]) {
    const state: Harness = harness();
    const failure: Error = new Error("Internal startup detail");
    runHttpProcess((): Promise<MurmurHttpServer> => {
      if (synchronous) throw failure;
      return Promise.reject(failure);
    }, state.runtime);
    await state.failed.promise;
    expect(state.listeners.size).toBe(0);
    expect(state.exitCodes).toEqual([1]);
    expect(state.failures).toEqual([{ message: "Murmur HTTP startup failed", error: failure }]);
  }
});

test("HTTP process reports cleanup failure once and prevents repeated shutdown attempts", async (): Promise<void> => {
  for (const synchronous of [false, true]) {
    const state: Harness = harness();
    const failure: Error = new Error("Internal cleanup detail");
    let calls: number = 0;
    runHttpProcess(
      async (): Promise<MurmurHttpServer> =>
        server((): Promise<void> => {
          calls += 1;
          if (synchronous) throw failure;
          return Promise.reject(failure);
        }),
      state.runtime,
    );
    await state.ready.promise;
    signal(state, "SIGTERM");
    await state.failed.promise;
    signal(state, "SIGINT");
    signal(state, "SIGTERM");
    expect(calls).toBe(1);
    expect(state.exitCodes).toEqual([1]);
    expect(state.failures).toEqual([{ message: "Murmur HTTP shutdown failed", error: failure }]);
  }
});
