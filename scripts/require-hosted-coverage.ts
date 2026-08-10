import process from "node:process";

import { parseDatabaseUrl } from "../src/database-url.js";

const HOSTED_COVERAGE_COMMAND: string =
  "MURMUR_VERIFY_COVERAGE=1 bash scripts/verify-hosted-postgres.sh";

function requiredPostgresUrl(environment: NodeJS.ProcessEnv, name: string): void {
  const value: string | undefined = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for strict hosted coverage`);
  }
  const parsed: URL = parseDatabaseUrl(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must use postgres: or postgresql:`);
  }
}

export function validateHostedCoverageEnvironment(environment: NodeJS.ProcessEnv): void {
  requiredPostgresUrl(environment, "MURMUR_TEST_APP_DATABASE_URL");
  requiredPostgresUrl(environment, "MURMUR_TEST_ADMIN_DATABASE_URL");
  const bootstrapToken: string | undefined = environment["MURMUR_TEST_BOOTSTRAP_LEGACY_TOKEN"];
  if (bootstrapToken === undefined || bootstrapToken.trim() === "") {
    throw new Error("MURMUR_TEST_BOOTSTRAP_LEGACY_TOKEN is required for strict hosted coverage");
  }
}

function main(): void {
  try {
    validateHostedCoverageEnvironment(process.env);
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${message}. Run '${HOSTED_COVERAGE_COMMAND}' against disposable PostgreSQL 17.\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
