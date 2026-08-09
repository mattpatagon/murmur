#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import postgres, { type Sql } from "postgres";

import { parseDatabaseUrl } from "../src/database-url.js";
import {
  deriveBootstrapCredential,
  type BootstrapCredential,
} from "../src/hosted/bootstrap-secret.js";
import { postgresSslOptions, postgresTlsConfiguration } from "../src/postgres-tls.js";
import { logSafeError } from "../src/safe-errors.js";

async function main(): Promise<void> {
  const databaseUrl: string | undefined = process.env["MURMUR_BOOTSTRAP_DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("MURMUR_BOOTSTRAP_DATABASE_URL is required");
  }
  parseDatabaseUrl(databaseUrl);
  const database: Sql = postgres(databaseUrl, {
    connect_timeout: 10,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, postgresTlsConfiguration(process.env)),
  });
  try {
    const credentialDatabaseUrl: string =
      process.env["MURMUR_BOOTSTRAP_DATABASE_CREDENTIAL"] ?? databaseUrl;
    const credential: BootstrapCredential = deriveBootstrapCredential(credentialDatabaseUrl);
    await database`
      SELECT murmur.configure_operator_bootstrap(
        ${randomUUID()}::uuid,
        ${credential.keyId},
        ${credential.hash}
      )
    `;
  } finally {
    await database.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur operator bootstrap configuration failed", error);
    process.exitCode = 1;
  });
}
