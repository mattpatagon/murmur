import process from "node:process";

import { parseDatabaseUrl } from "../src/database-url.js";

const DOCKER_HOST_NAME: string = "host.docker.internal";
const LOOPBACK_HOST_NAMES: ReadonlySet<string> = new Set<string>([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

export function databaseUrlForDocker(databaseUrl: string): string {
  const parsed: URL = parseDatabaseUrl(databaseUrl);
  if (LOOPBACK_HOST_NAMES.has(parsed.hostname)) parsed.hostname = DOCKER_HOST_NAME;
  return parsed.toString();
}

export function validateCrossPlatformTestEnvironment(
  environment: NodeJS.ProcessEnv,
  dockerExecutable: string | null,
): void {
  const databaseUrl: string | undefined = environment["MURMUR_TEST_DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("MURMUR_TEST_DATABASE_URL is required for the Linux-container test");
  }
  const parsed: URL = parseDatabaseUrl(databaseUrl);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("MURMUR_TEST_DATABASE_URL must use postgres: or postgresql:");
  }
  if (dockerExecutable === null) {
    throw new Error("Docker is required for the Linux-container test");
  }
}

function main(): void {
  try {
    validateCrossPlatformTestEnvironment(process.env, Bun.which("docker"));
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
