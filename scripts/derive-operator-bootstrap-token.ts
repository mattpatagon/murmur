#!/usr/bin/env bun

import process from "node:process";

import { parseDatabaseUrl } from "../src/database-url.js";
import { deriveBootstrapCredential } from "../src/hosted/bootstrap-secret.js";
import { logSafeError } from "../src/safe-errors.js";

function main(): void {
  const databaseCredential: string | undefined =
    process.env["MURMUR_BOOTSTRAP_DATABASE_CREDENTIAL"];
  if (databaseCredential === undefined || databaseCredential === "") {
    throw new Error("MURMUR_BOOTSTRAP_DATABASE_CREDENTIAL is required");
  }
  parseDatabaseUrl(databaseCredential);
  process.stdout.write(`${deriveBootstrapCredential(databaseCredential).secret}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    logSafeError("Murmur operator bootstrap token derivation failed", error);
    process.exitCode = 1;
  }
}
