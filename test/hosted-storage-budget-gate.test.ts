import { expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";

test("requested storage budget gate fails instead of skipping without database URLs", (): void => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MURMUR_TEST_STORAGE_BUDGET: "1",
  };
  environment["MURMUR_TEST_ADMIN_DATABASE_URL"] = undefined;
  environment["MURMUR_TEST_APP_DATABASE_URL"] = undefined;
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    ["--eval", "await import('./test/support/hosted-storage-budget.ts')"],
    { encoding: "utf8", env: environment, timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "Requested storage budget gate requires both disposable PostgreSQL URLs",
  );
});

test("authoritative PostgreSQL gate runs budget tests after bootstrap in both coverage modes", async (): Promise<void> => {
  const script: string = await Bun.file("scripts/verify-hosted-postgres.sh").text();
  expect(script).toMatch(
    /MURMUR_TEST_STORAGE_BUDGET=0\s*\\\n\s*bun run scripts\/run-coverage\.ts/u,
  );
  const serialGate: RegExp =
    /fi\n\n#[^\n]+\nMURMUR_TEST_APP_DATABASE_URL="\$app_url"\s*\\\n\s*MURMUR_TEST_ADMIN_DATABASE_URL="\$admin_url"\s*\\\n\s*MURMUR_TEST_DATABASE_TLS_INSECURE=1\s*\\\n\s*MURMUR_TEST_STORAGE_BUDGET=1\s*\\\n\s*bun test test\/hosted-storage-budget\.postgres\.test\.ts\s*\\\n\s*test\/hosted-storage-budget-e2ee\.postgres\.test\.ts/u;
  expect(script).toMatch(serialGate);
});
