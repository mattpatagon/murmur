#!/usr/bin/env bun

import process from "node:process";

import { parseDatabaseUrl } from "../src/database-url.js";
import { logSafeError } from "../src/safe-errors.js";

function main(): void {
  const value: string | undefined = process.env["MURMUR_DATABASE_URL_TO_VERIFY"];
  if (value === undefined || value === "") {
    throw new Error("MURMUR_DATABASE_URL_TO_VERIFY is required");
  }
  const url: URL = parseDatabaseUrl(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("The configured database URL must use postgres or postgresql");
  }
  url.searchParams.set("sslmode", "verify-full");
  const certificatePath: string | undefined = process.env["MURMUR_DATABASE_CA_PATH"];
  if (certificatePath !== undefined && certificatePath !== "") {
    url.searchParams.set("sslrootcert", certificatePath);
  }
  process.stdout.write(url.toString());
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    logSafeError("Murmur database TLS URL normalization failed", error);
    process.exitCode = 1;
  }
}
