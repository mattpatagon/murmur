#!/usr/bin/env bun

import process from "node:process";

import postgres, { type Sql } from "postgres";

import { parseDatabaseUrl } from "../src/database-url.js";
import { postgresSslOptions, postgresTlsConfiguration } from "../src/postgres-tls.js";
import { logSafeError } from "../src/safe-errors.js";

const RuntimeDatabaseUsernamePattern: RegExp = /^murmur_app(?:\.[A-Za-z0-9_-]+)?$/u;

function parsedPostgresUrl(value: string): URL {
  const url: URL = parseDatabaseUrl(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("The runtime database URL must use postgres or postgresql");
  }
  return url;
}

function decodedUrlComponent(value: string, component: string): string {
  try {
    return decodeURIComponent(value);
  } catch (_error: unknown) {
    throw new Error(`The runtime database URL has an invalid ${component}`);
  }
}

function requireRuntimePassword(password: string): string {
  if (Buffer.byteLength(password, "utf8") < 32) {
    throw new Error("MURMUR_RUNTIME_PASSWORD must contain at least 32 bytes");
  }
  return password;
}

export function runtimeUsername(adminUsername: string): string {
  const suffixIndex: number = adminUsername.indexOf(".");
  return suffixIndex === -1 ? "murmur_app" : `murmur_app${adminUsername.slice(suffixIndex)}`;
}

export function runtimeDatabaseUrlKind(value: string): "runtime" | "template" {
  const url: URL = parsedPostgresUrl(value);
  const username: string = decodedUrlComponent(url.username, "username");
  if (!RuntimeDatabaseUsernamePattern.test(username)) return "template";
  runtimePasswordFromDatabaseUrl(value);
  return "runtime";
}

export function runtimePasswordFromDatabaseUrl(value: string): string {
  const url: URL = parsedPostgresUrl(value);
  const username: string = decodedUrlComponent(url.username, "username");
  if (!RuntimeDatabaseUsernamePattern.test(username)) {
    throw new Error("The database URL is not a murmur_app runtime credential");
  }
  return requireRuntimePassword(decodedUrlComponent(url.password, "password"));
}

export function buildRuntimeDatabaseUrl(templateDatabaseUrl: string, password: string): string {
  const parsedTemplateUrl: URL = parsedPostgresUrl(templateDatabaseUrl);
  const templateUsername: string = decodedUrlComponent(parsedTemplateUrl.username, "username");
  parsedTemplateUrl.username = runtimeUsername(templateUsername);
  parsedTemplateUrl.password = encodeURIComponent(requireRuntimePassword(password));
  return parsedTemplateUrl.toString();
}

async function main(): Promise<void> {
  const inspectDatabaseUrl: string | undefined =
    process.env["MURMUR_RUNTIME_DATABASE_URL_TO_INSPECT"];
  if (inspectDatabaseUrl !== undefined && inspectDatabaseUrl !== "") {
    process.stdout.write(runtimeDatabaseUrlKind(inspectDatabaseUrl));
    return;
  }
  const adminDatabaseUrl: string | undefined = process.env["MURMUR_RUNTIME_ADMIN_DATABASE_URL"];
  if (adminDatabaseUrl === undefined || adminDatabaseUrl === "") {
    throw new Error("MURMUR_RUNTIME_ADMIN_DATABASE_URL is required");
  }
  const credentialDatabaseUrl: string | undefined =
    process.env["MURMUR_RUNTIME_DATABASE_CREDENTIAL_URL"];
  const configuredPassword: string | undefined = process.env["MURMUR_RUNTIME_PASSWORD"];
  const password: string =
    credentialDatabaseUrl === undefined || credentialDatabaseUrl === ""
      ? requireRuntimePassword(configuredPassword ?? "")
      : runtimePasswordFromDatabaseUrl(credentialDatabaseUrl);
  if (process.env["MURMUR_RUNTIME_APPLY"] === "1") {
    const database: Sql = postgres(adminDatabaseUrl, {
      connect_timeout: 10,
      max: 1,
      ssl: postgresSslOptions(adminDatabaseUrl, postgresTlsConfiguration(process.env)),
    });
    try {
      await database`SELECT murmur.configure_runtime_role_password(${password})`;
      return;
    } finally {
      await database.end({ timeout: 5 });
    }
  }
  if (credentialDatabaseUrl !== undefined && credentialDatabaseUrl !== "") {
    throw new Error("MURMUR_RUNTIME_APPLY=1 is required to recover a staged credential");
  }
  const templateDatabaseUrl: string =
    process.env["MURMUR_RUNTIME_DATABASE_TEMPLATE_URL"] ?? adminDatabaseUrl;
  const parsedTemplateUrl: URL = parsedPostgresUrl(templateDatabaseUrl);
  const parsedAdminUrl: URL = parsedPostgresUrl(adminDatabaseUrl);
  if (parsedTemplateUrl.username === "") {
    parsedTemplateUrl.username = parsedAdminUrl.username;
  }
  process.stdout.write(buildRuntimeDatabaseUrl(parsedTemplateUrl.toString(), password));
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur runtime database provisioning failed", error);
    process.exitCode = 1;
  });
}
