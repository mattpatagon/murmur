import { z } from "zod";

export type HostedLoadConfig = {
  readonly adminUrl: string;
  readonly runtimeUrl: string;
  readonly databaseName: string;
  readonly tenantCount: number;
  readonly concurrency: number;
  readonly maxSessionCount: number;
  readonly durationSeconds: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxRssBytes: number;
};

export class HostedLoadFailure extends Error {}

export function requireLoad(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HostedLoadFailure(message);
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return z.coerce
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .parse(environment[name] ?? fallback);
}

function databaseUrl(value: string | undefined): URL {
  requireLoad(value !== undefined, "Both dedicated load database URLs are required");
  const url: URL = new URL(value);
  requireLoad(
    (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      /^\/murmur_load_[a-z0-9_]{1,32}$/u.test(url.pathname) &&
      url.hash === "" &&
      url.username !== "" &&
      url.password !== "",
    "Load database must be credentialed literal loopback PostgreSQL named murmur_load_<suffix>",
  );
  for (const [name, value_] of url.searchParams) {
    requireLoad(name === "sslmode" && value_ === "disable", "Unsupported load database option");
  }
  return url;
}

export function verifyLoadWorkerEnvironment(environment: NodeJS.ProcessEnv): void {
  requireLoad(
    environment["MURMUR_LOAD_DISPOSABLE"] === "1",
    "Load worker requires disposable opt-in",
  );
  const runtime: URL = databaseUrl(environment["MURMUR_DATABASE_URL"]);
  requireLoad(
    decodeURIComponent(runtime.username) === "murmur_app",
    "Load worker requires the runtime role",
  );
}

export function loadConfig(environment: NodeJS.ProcessEnv): HostedLoadConfig {
  requireLoad(
    environment["MURMUR_LOAD_DISPOSABLE"] === "1",
    "Explicit disposable database opt-in is required",
  );
  const admin: URL = databaseUrl(environment["MURMUR_LOAD_ADMIN_DATABASE_URL"]);
  const runtime: URL = databaseUrl(environment["MURMUR_LOAD_RUNTIME_DATABASE_URL"]);
  requireLoad(
    admin.hostname === runtime.hostname &&
      (admin.port || "5432") === (runtime.port || "5432") &&
      admin.pathname === runtime.pathname &&
      decodeURIComponent(runtime.username) === "murmur_app" &&
      decodeURIComponent(admin.username) !== "murmur_app",
    "Load database URLs must identify the same dedicated database and separate runtime role",
  );
  return {
    adminUrl: admin.href,
    runtimeUrl: runtime.href,
    databaseName: runtime.pathname.slice(1),
    tenantCount: integer(environment, "MURMUR_LOAD_TENANTS", 25_000, 128, 25_000),
    concurrency: integer(environment, "MURMUR_LOAD_CONCURRENCY", 8, 1, 64),
    maxSessionCount: integer(environment, "MURMUR_LOAD_SESSIONS", 1_000, 64, 1_000),
    durationSeconds: integer(environment, "MURMUR_LOAD_DURATION_SECONDS", 3_600, 120, 7_200),
    p95Ms: integer(environment, "MURMUR_LOAD_P95_MS", 2_000, 50, 5_000),
    p99Ms: integer(environment, "MURMUR_LOAD_P99_MS", 5_000, 100, 10_000),
    maxRssBytes: integer(environment, "MURMUR_LOAD_RSS_MIB", 512, 128, 512) * 1_048_576,
  };
}

export async function loadWorkers(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<void>,
): Promise<void> {
  requireLoad(
    Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= 25_000 &&
      Number.isSafeInteger(concurrency) &&
      concurrency >= 1 &&
      concurrency <= 64,
    "Load worker admission is outside its bounds",
  );
  let next: number = 0;
  const failures: unknown[] = [];
  const worker: () => Promise<void> = async (): Promise<void> => {
    while (next < count && failures.length === 0) {
      const index: number = next;
      next += 1;
      try {
        await operation(index);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  if (failures.length > 0) throw failures[0];
}
