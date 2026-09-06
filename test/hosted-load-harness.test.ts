import { expect, test } from "bun:test";

import {
  type HostedLoadConfig,
  loadConfig,
  loadWorkers,
  verifyLoadWorkerEnvironment,
} from "../scripts/lib/hosted-load-config.js";
import { LoadPhase, type PhaseReport } from "../scripts/lib/hosted-load-metrics.js";

function fixtureUrl(
  username: string,
  hostname: string = "127.0.0.1",
  database: string = "murmur_load_test",
): string {
  const url: URL = new URL(`postgresql://${hostname}:5432/${database}?sslmode=disable`);
  url.username = username;
  url.password = "disposable-fixture";
  return url.href;
}

function environment(): NodeJS.ProcessEnv {
  return {
    MURMUR_LOAD_DISPOSABLE: "1",
    MURMUR_LOAD_ADMIN_DATABASE_URL: fixtureUrl("postgres"),
    MURMUR_LOAD_RUNTIME_DATABASE_URL: fixtureUrl("murmur_app"),
  };
}

test("hosted load configuration defaults to 25,000 accounts within production memory/session bounds", (): void => {
  const config: HostedLoadConfig = loadConfig(environment());
  expect(config.tenantCount).toBe(25_000);
  expect(config.maxSessionCount).toBe(1_000);
  expect(config.maxRssBytes).toBe(512 * 1_048_576);
  expect(config.concurrency).toBe(8);
  expect(config.databaseName).toBe("murmur_load_test");
});

test("hosted load refuses remote, DNS, generic and option-overridden database targets", (): void => {
  for (const candidate of [
    fixtureUrl("postgres", "192.0.2.10"),
    fixtureUrl("postgres", "localhost"),
    fixtureUrl("postgres", "127.0.0.1", "postgres"),
    fixtureUrl("postgres", "127.0.0.1", "murmur_load_"),
    `${fixtureUrl("postgres")}&host=remote.example`,
    `${fixtureUrl("postgres")}&options=role%3Dpostgres`,
    `${fixtureUrl("postgres")}#fragment`,
  ]) {
    expect(
      (): HostedLoadConfig =>
        loadConfig({ ...environment(), MURMUR_LOAD_ADMIN_DATABASE_URL: candidate }),
    ).toThrow();
  }
});

test("hosted load requires explicit opt-in, matching databases and separate runtime identity", (): void => {
  const missing: NodeJS.ProcessEnv = environment();
  missing["MURMUR_LOAD_DISPOSABLE"] = undefined;
  expect((): HostedLoadConfig => loadConfig(missing)).toThrow("opt-in");
  for (const candidate of [
    fixtureUrl("postgres"),
    fixtureUrl("murmur_app", "127.0.0.1", "murmur_load_other"),
    fixtureUrl("murmur_app").replace(":5432/", ":5433/"),
    fixtureUrl("murmur_app", "[::1]"),
  ]) {
    expect(
      (): HostedLoadConfig =>
        loadConfig({ ...environment(), MURMUR_LOAD_RUNTIME_DATABASE_URL: candidate }),
    ).toThrow();
  }
  expect(
    (): HostedLoadConfig =>
      loadConfig({ ...environment(), MURMUR_LOAD_ADMIN_DATABASE_URL: fixtureUrl("murmur_app") }),
  ).toThrow();
});

test("hosted load accepts a matched literal IPv6 disposable database and rejects widened budgets", (): void => {
  expect(
    loadConfig({
      ...environment(),
      MURMUR_LOAD_ADMIN_DATABASE_URL: fixtureUrl("postgres", "[::1]"),
      MURMUR_LOAD_RUNTIME_DATABASE_URL: fixtureUrl("murmur_app", "[::1]"),
    }).databaseName,
  ).toBe("murmur_load_test");
  for (const [name, value] of Object.entries({
    MURMUR_LOAD_TENANTS: "25001",
    MURMUR_LOAD_CONCURRENCY: "65",
    MURMUR_LOAD_SESSIONS: "1001",
    MURMUR_LOAD_RSS_MIB: "513",
    MURMUR_LOAD_DURATION_SECONDS: "7201",
    MURMUR_LOAD_P95_MS: "5001",
    MURMUR_LOAD_P99_MS: "10001",
  })) {
    expect((): HostedLoadConfig => loadConfig({ ...environment(), [name]: value })).toThrow();
  }
});

test("the worker independently refuses non-disposable or privileged targets", (): void => {
  expect((): void =>
    verifyLoadWorkerEnvironment({ MURMUR_DATABASE_URL: fixtureUrl("murmur_app") }),
  ).toThrow();
  expect((): void =>
    verifyLoadWorkerEnvironment({
      MURMUR_LOAD_DISPOSABLE: "1",
      MURMUR_DATABASE_URL: fixtureUrl("postgres"),
    }),
  ).toThrow();
  expect((): void =>
    verifyLoadWorkerEnvironment({
      MURMUR_LOAD_DISPOSABLE: "1",
      MURMUR_DATABASE_URL: fixtureUrl("murmur_app", "192.0.2.10"),
    }),
  ).toThrow();
  expect((): void =>
    verifyLoadWorkerEnvironment({
      MURMUR_LOAD_DISPOSABLE: "1",
      MURMUR_DATABASE_URL: fixtureUrl("murmur_app"),
    }),
  ).not.toThrow();
});

test("load metrics retain rejected attempts and percentile operation latency", (): void => {
  const phase: LoadPhase = new LoadPhase("test", 4);
  phase.recordAttempt(503, 3);
  phase.recordAttempt(429, 4);
  phase.retries = 2;
  for (let value: number = 1; value <= 100; value += 1) {
    phase.recordAttempt(200, value * 2);
    phase.recordOperation(value);
  }
  const report: PhaseReport = phase.report();
  expect(report.statusCodes).toEqual({ "200": 100, "429": 1, "503": 1 });
  expect(report.httpAttempts).toBe(102);
  expect(report.retries).toBe(2);
  expect(report.operationP50Ms).toBe(50);
  expect(report.operationP95Ms).toBe(95);
  expect(report.operationP99Ms).toBe(99);
  expect(report.attemptsPerSecond).toBeGreaterThan(0);
});

test("load worker failure stops admission and waits for already-started work", async (): Promise<void> => {
  let release: () => void = (): void => {};
  const gate: Promise<void> = new Promise((resolve: () => void): void => {
    release = resolve;
  });
  const started: number[] = [];
  let finished: boolean = false;
  const operation: Promise<void> = loadWorkers(100, 2, async (index: number): Promise<void> => {
    started.push(index);
    if (index === 0) throw new Error("Expected fixture failure");
    await gate;
    finished = true;
  });
  const observed: Promise<unknown> = operation.then(
    (): null => null,
    (error: unknown): unknown => error,
  );
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
  expect(finished).toBe(false);
  release();
  const error: unknown = await observed;
  expect(error instanceof Error && error.message === "Expected fixture failure").toBe(true);
  expect(finished).toBe(true);
  expect(started).toEqual([0, 1]);
});

test("load worker admission rejects zero or excessive concurrency before invoking work", async (): Promise<void> => {
  let invoked: boolean = false;
  const operation: () => Promise<void> = async (): Promise<void> => {
    invoked = true;
  };
  await expect(loadWorkers(1, 0, operation)).rejects.toThrow("bounds");
  await expect(loadWorkers(1, 65, operation)).rejects.toThrow("bounds");
  await expect(loadWorkers(25_001, 1, operation)).rejects.toThrow("bounds");
  expect(invoked).toBe(false);
});
