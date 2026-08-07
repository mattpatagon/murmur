import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { UnsupportedDatabaseError } from "../domain/errors.js";
import type { MessageStore } from "./message-store.js";
import { PostgresMessageStore, type PostgresTlsConfiguration } from "./postgres-message-store.js";
import { SqliteMessageStore } from "./sqlite-message-store.js";

function sqlitePathFromUrl(value: string): string {
  const url: URL = new URL(value);
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
    const url: URL = new URL(databaseUrl);
    if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
      const certificatePath: string | undefined = environment["MURMUR_DATABASE_CA_PATH"];
      const tlsConfiguration: PostgresTlsConfiguration =
        certificatePath === undefined || certificatePath === ""
          ? { mode: "require" }
          : {
              certificateAuthority: readFileSync(resolve(certificatePath), "utf8"),
              mode: "verify-full",
            };
      return await PostgresMessageStore.connect(databaseUrl, tlsConfiguration);
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
