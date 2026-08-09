import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDatabaseUrl } from "../database-url.js";
import { UnsupportedDatabaseError } from "../domain/errors.js";
import { postgresTlsConfiguration } from "../postgres-tls.js";
import type { MessageStore } from "./message-store.js";
import { PostgresMessageStore } from "./postgres-message-store.js";
import { SqliteMessageStore } from "./sqlite-message-store.js";

function sqlitePathFromUrl(value: string): string {
  const url: URL = parseDatabaseUrl(value);
  if (url.protocol === "file:") return fileURLToPath(url);
  if (url.protocol !== "sqlite:") throw new UnsupportedDatabaseError(url.protocol);

  const decodedPath: string = decodeURIComponent(url.pathname);
  if (decodedPath.startsWith("/")) return decodedPath;
  return resolve(decodedPath);
}

export async function createStore(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MessageStore> {
  const databaseUrl: string | undefined = environment["MURMUR_DATABASE_URL"];
  if (databaseUrl !== undefined && databaseUrl !== "") {
    const url: URL = parseDatabaseUrl(databaseUrl);
    if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
      return await PostgresMessageStore.connect(databaseUrl, postgresTlsConfiguration(environment));
    }
    return new SqliteMessageStore(sqlitePathFromUrl(databaseUrl));
  }
  const configuredPath: string | undefined = environment["MURMUR_DB_PATH"];
  const databasePath: string =
    configuredPath === undefined || configuredPath === ""
      ? resolve(".murmur/messages.db")
      : resolve(configuredPath);
  return new SqliteMessageStore(databasePath);
}
