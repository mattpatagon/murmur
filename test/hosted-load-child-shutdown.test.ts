import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { closeHostedLoadChild } from "../scripts/lib/hosted-load-child-shutdown.js";
import type { HostedLoadConfig } from "../scripts/lib/hosted-load-config.js";
import { HostedLoadServer } from "../scripts/lib/hosted-load-server.js";
import {
  HostedLoadChildFixture,
  HostedLoadShutdownClock,
} from "./support/hosted-load-child-fixture.js";

const CONFIG: HostedLoadConfig = {
  adminUrl: "unused",
  runtimeUrl: "unused",
  databaseName: "murmur_load_shutdown",
  tenantCount: 25_000,
  concurrency: 8,
  maxSessionCount: 1_000,
  durationSeconds: 3_600,
  p95Ms: 2_000,
  p99Ms: 5_000,
  maxRssBytes: 512 * 1_048_576,
};

async function withServer(
  run: (server: HostedLoadServer, fixture: HostedLoadChildFixture) => Promise<void>,
): Promise<void> {
  const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
  const fork: ReturnType<typeof spyOn<typeof childProcess, "fork">> = spyOn(
    childProcess,
    "fork",
  ).mockReturnValue(fixture.child);
  try {
    const server: HostedLoadServer = new HostedLoadServer(CONFIG);
    fixture.child.emit("message", { kind: "ready", port: "12345", rss: 1 });
    await server.url();
    await run(server, fixture);
  } finally {
    fixture.exit(0);
    fork.mockRestore();
  }
}

test("load child shutdown rejects a worker shutdown failure and retains it on repeated close", async (): Promise<void> => {
  await withServer(
    async (server: HostedLoadServer, fixture: HostedLoadChildFixture): Promise<void> => {
      const close: Promise<void> = server.close();
      fixture.exit(1);
      await expect(close).rejects.toThrow("Hosted load child shutdown failed");
      await expect(server.close()).rejects.toThrow("Hosted load child shutdown failed");
      expect(fixture.messages).toEqual(["stop"]);
    },
  );
});

test("load child shutdown rejects an exit that preceded the close request", async (): Promise<void> => {
  await withServer(
    async (server: HostedLoadServer, fixture: HostedLoadChildFixture): Promise<void> => {
      fixture.exit(0);
      await expect(server.close()).rejects.toThrow("Hosted load child shutdown failed");
      expect(fixture.messages).toEqual([]);
      expect(fixture.signals).toEqual([]);
    },
  );
});

test("concurrent load child closes share completion until the graceful exit is observed", async (): Promise<void> => {
  await withServer(
    async (server: HostedLoadServer, fixture: HostedLoadChildFixture): Promise<void> => {
      const first: Promise<void> = server.close();
      const second: Promise<void> = server.close();
      expect(second).toBe(first);
      let completed: boolean = false;
      const observe: Promise<void> = second.then((): void => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      fixture.exit(0);
      await Promise.all([first, second, observe]);
      expect(completed).toBe(true);
      expect(fixture.messages).toEqual(["stop"]);
      expect(server.close()).toBe(first);
      expect((): void => server.verifyHealthy()).toThrow();
    },
  );
});

for (const stage of ["before", "during"]) {
  test(`load child retains a worker failure reported ${stage} otherwise graceful shutdown`, async (): Promise<void> => {
    await withServer(
      async (server: HostedLoadServer, fixture: HostedLoadChildFixture): Promise<void> => {
        if (stage === "before") fixture.child.emit("message", { kind: "failed" });
        const close: Promise<void> = server.close();
        if (stage === "during") fixture.child.emit("message", { kind: "failed" });
        fixture.exit(0);
        await expect(close).rejects.toThrow("Hosted load child shutdown failed");
        await expect(server.close()).rejects.toThrow("Hosted load child shutdown failed");
      },
    );
  });
}

function outcome(close: Promise<void>): Promise<Error | null> {
  return close.then(
    (): null => null,
    (error: unknown): Error => {
      if (!(error instanceof Error)) throw new Error("Unexpected shutdown failure type");
      return error;
    },
  );
}

function expectClean(fixture: HostedLoadChildFixture, clock: HostedLoadShutdownClock): void {
  expect(clock.timers).toBe(0);
  expect(fixture.child.listenerCount("exit")).toBe(0);
  expect(fixture.child.listenerCount("error")).toBe(0);
}

function expectFailure(error: Error | null, unconfirmed: boolean = false): void {
  expect(error).toBeInstanceOf(Error);
  if (error === null) throw new Error("Expected shutdown to fail");
  expect(error.message).toBe(
    unconfirmed
      ? "Hosted load child shutdown failed: terminal exit unconfirmed"
      : "Hosted load child shutdown failed",
  );
}

test("graceful child shutdown waits for both successful IPC acknowledgement and observed exit", async (): Promise<void> => {
  const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
  fixture.sendAcknowledged = false;
  const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
  const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
  let completed: boolean = false;
  const observe: Promise<void> = close.then((): void => {
    completed = true;
  });
  fixture.exit(0);
  await Promise.resolve();
  expect(completed).toBe(false);
  fixture.acknowledge();
  expect(await close).toBeNull();
  await observe;
  expect(fixture.messages).toEqual(["stop"]);
  expect(fixture.signals).toEqual([]);
  expectClean(fixture, clock);
});

type FailedExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
const FAILED_EXITS: readonly FailedExit[] = [
  { code: 1, signal: null },
  { code: null, signal: "SIGTERM" },
  { code: null, signal: "SIGKILL" },
];
for (const exit of FAILED_EXITS) {
  test(`observed child exit ${exit.code}/${exit.signal} is never successful cleanup`, async (): Promise<void> => {
    const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
    const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
    const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
    fixture.exit(exit.code, exit.signal);
    expectFailure(await close);
    expectClean(fixture, clock);
  });
}

test("disconnected child requests SIGTERM and succeeds only after the handler exits zero", async (): Promise<void> => {
  const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
  fixture.disconnected();
  const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
  const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
  expect(fixture.messages).toEqual([]);
  expect(fixture.signals).toEqual(["SIGTERM"]);
  fixture.exit(0);
  expect(await close).toBeNull();
  expectClean(fixture, clock);
});

for (const failure of ["callback", "throw", "event", "deadline"]) {
  test(`IPC ${failure} remains a failure while waiting for terminal cleanup`, async (): Promise<void> => {
    const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
    const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
    fixture.sendThrows = failure === "throw";
    fixture.sendError = failure === "callback" ? new Error("Private IPC exception") : null;
    fixture.sendAcknowledged = failure !== "deadline" && failure !== "event";
    const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
    let fixtureCleanup: boolean = false;
    const cleanup: Promise<void> = close.then((): void => {
      fixtureCleanup = true;
    });
    if (failure === "event") fixture.child.emit("error", new Error("Private worker error"));
    if (failure === "deadline") {
      clock.advance(999);
      expect(fixture.signals).toEqual([]);
      clock.advance(1);
    }
    await Promise.resolve();
    expect(fixtureCleanup).toBe(false);
    expect(fixture.signals).toEqual(["SIGTERM"]);
    fixture.exit(0);
    expectFailure(await close);
    await cleanup;
    expect(fixtureCleanup).toBe(true);
    expectClean(fixture, clock);
    if (failure === "deadline") fixture.acknowledge(new Error("Private late IPC exception"));
    expect(fixture.signals).toEqual(["SIGTERM"]);
  });
}

test("an IPC callback failure arriving after exit zero cannot be mislabeled graceful shutdown", async (): Promise<void> => {
  const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
  fixture.sendAcknowledged = false;
  const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
  const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
  fixture.exit(0);
  fixture.acknowledge(new Error("Private late IPC error"));
  expectFailure(await close);
  expect(fixture.signals).toEqual([]);
  expectClean(fixture, clock);
});

for (const gracefulCode of [false, true]) {
  test(`forced termination awaits terminal exit and rejects even exit zero=${gracefulCode}`, async (): Promise<void> => {
    const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
    const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
    const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
    let completed: boolean = false;
    const observe: Promise<void> = close.then((): void => {
      completed = true;
    });
    clock.advance(5_999);
    expect(fixture.signals).toEqual([]);
    clock.advance(1);
    expect(fixture.signals).toEqual(["SIGKILL"]);
    await Promise.resolve();
    expect(completed).toBe(false);
    fixture.exit(gracefulCode ? 0 : null, gracefulCode ? null : "SIGKILL");
    expectFailure(await close);
    await observe;
    expectClean(fixture, clock);
  });
}

for (const kill of ["accepted", "rejected", "throws"]) {
  test(`unobserved exit after kill ${kill} rejects at the final deadline without leaking timers`, async (): Promise<void> => {
    const fixture: HostedLoadChildFixture = new HostedLoadChildFixture();
    fixture.disconnected();
    fixture.killAccepted = kill !== "rejected";
    fixture.killThrows = kill === "throws";
    const clock: HostedLoadShutdownClock = new HostedLoadShutdownClock();
    const close: Promise<Error | null> = outcome(closeHostedLoadChild(fixture.child, clock));
    let completed: boolean = false;
    const observe: Promise<void> = close.then((): void => {
      completed = true;
    });
    clock.advance(7_999);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(fixture.signals).toEqual(["SIGTERM", "SIGKILL"]);
    clock.advance(1);
    expectFailure(await close, true);
    await observe;
    expectClean(fixture, clock);
    fixture.exit(0);
    clock.advance(60_000);
    expect(fixture.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
}
