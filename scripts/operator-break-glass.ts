#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import postgres, { type Sql } from "postgres";

import { parseDatabaseUrl } from "../src/database-url.js";
import { generateTokenSecret, type HostedTokenSecret } from "../src/hosted/token-secret.js";
import { postgresSslOptions, postgresTlsConfiguration } from "../src/postgres-tls.js";
import { logSafeError } from "../src/safe-errors.js";

async function main(): Promise<void> {
  const databaseUrl: string | undefined = process.env["MURMUR_BREAK_GLASS_DATABASE_URL"];
  const reason: string | undefined = process.env["MURMUR_BREAK_GLASS_REASON"];
  const name: string = process.env["MURMUR_BREAK_GLASS_NAME"] ?? "Emergency recovery operator";
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("MURMUR_BREAK_GLASS_DATABASE_URL is required");
  }
  if (reason === undefined || reason.trim().length < 10) {
    throw new Error("MURMUR_BREAK_GLASS_REASON must contain at least 10 characters");
  }
  if (name.trim().length === 0 || name.length > 200) {
    throw new Error("MURMUR_BREAK_GLASS_NAME must contain 1 to 200 characters");
  }
  parseDatabaseUrl(databaseUrl);
  const issued: HostedTokenSecret = generateTokenSecret("mur_op");
  const tokenId: string = randomUUID();
  const database: Sql = postgres(databaseUrl, {
    connect_timeout: 10,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, postgresTlsConfiguration(process.env)),
  });
  try {
    await database`
      SELECT murmur.operator_break_glass_create(
        ${tokenId}::uuid,
        ${issued.keyId},
        ${issued.hash},
        ${name.trim()},
        ${reason.trim()}
      )
    `;
  } finally {
    await database.end({ timeout: 5 });
  }
  process.stdout.write(`${issued.secret}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur operator break-glass recovery failed", error);
    process.exitCode = 1;
  });
}
