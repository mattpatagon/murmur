#!/usr/bin/env bun

import process from "node:process";

import postgres, { type Sql } from "postgres";

import { parseDatabaseUrl } from "../src/database-url.js";
import { postgresSslOptions, postgresTlsConfiguration } from "../src/postgres-tls.js";
import { logSafeError } from "../src/safe-errors.js";

function runtimeUsername(adminUsername: string): string {
  const suffixIndex: number = adminUsername.indexOf(".");
  return suffixIndex === -1 ? "murmur_app" : `murmur_app${adminUsername.slice(suffixIndex)}`;
}

async function main(): Promise<void> {
  const adminDatabaseUrl: string | undefined = process.env["MURMUR_RUNTIME_ADMIN_DATABASE_URL"];
  if (adminDatabaseUrl === undefined || adminDatabaseUrl === "") {
    throw new Error("MURMUR_RUNTIME_ADMIN_DATABASE_URL is required");
  }
  const templateDatabaseUrl: string =
    process.env["MURMUR_RUNTIME_DATABASE_TEMPLATE_URL"] ?? adminDatabaseUrl;
  const parsedAdminUrl: URL = parseDatabaseUrl(adminDatabaseUrl);
  const parsedTemplateUrl: URL = parseDatabaseUrl(templateDatabaseUrl);
  const password: string | undefined = process.env["MURMUR_RUNTIME_PASSWORD"];
  if (password === undefined || password.length < 32) {
    throw new Error("MURMUR_RUNTIME_PASSWORD must contain at least 32 characters");
  }
  const database: Sql = postgres(adminDatabaseUrl, {
    connect_timeout: 10,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, postgresTlsConfiguration(process.env)),
  });
  try {
    if (process.env["MURMUR_RUNTIME_APPLY"] === "1") {
      await database`SELECT murmur.configure_runtime_role_password(${password})`;
      return;
    }
  } finally {
    await database.end({ timeout: 5 });
  }
  parsedTemplateUrl.username = runtimeUsername(
    parsedTemplateUrl.username || parsedAdminUrl.username,
  );
  parsedTemplateUrl.password = password;
  process.stdout.write(parsedTemplateUrl.toString());
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur runtime database provisioning failed", error);
    process.exitCode = 1;
  });
}
