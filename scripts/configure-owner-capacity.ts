#!/usr/bin/env bun

import process from "node:process";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { parseDatabaseUrl } from "../src/database-url.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions, postgresTlsConfiguration } from "../src/postgres-tls.js";
import { logSafeError } from "../src/safe-errors.js";

const EnabledRowsSchema: z.ZodType<readonly [{ readonly owner_reserve_enabled: true }]> = z.tuple([
  z.strictObject({ owner_reserve_enabled: z.literal(true) }),
]);

async function main(): Promise<void> {
  const databaseUrl: string | undefined = process.env["MURMUR_OWNER_ADMIN_DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("MURMUR_OWNER_ADMIN_DATABASE_URL is required");
  }
  parseDatabaseUrl(databaseUrl);
  const database: Sql = postgres(databaseUrl, {
    connect_timeout: 10,
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, postgresTlsConfiguration(process.env)),
  });
  try {
    await database.begin(async (transaction: TransactionSql): Promise<void> => {
      const raw: unknown = await transaction`
        UPDATE murmur.hosted_storage_budget SET owner_reserve_enabled = true
        WHERE singleton_id = 1 RETURNING owner_reserve_enabled
      `;
      EnabledRowsSchema.parse(raw);
    });
    process.stdout.write("Owner storage reserve enabled.\n");
  } finally {
    await database.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur owner capacity configuration failed", error);
    process.exitCode = 1;
  });
}
