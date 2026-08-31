import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseDatabaseUrl } from "../src/database-url.js";
import { StorageCorruptionError, UnsupportedDatabaseError } from "../src/domain/errors.js";
import { AgentId, TenantId } from "../src/domain/value-objects.js";
import {
  createHostedAuthenticator,
  InvalidBootstrapFlagError,
  InvalidBootstrapConfigurationError,
  InvalidHostedAuthModeError,
  InvalidTenantContractVersionError,
  MissingHostedDatabaseError,
  MissingLegacyApiTokenError,
} from "../src/hosted/authenticator.js";
import { type HttpServerConfig, parseHttpServerConfig } from "../src/http/http-config.js";
import { createStore } from "../src/storage/create-store.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

test("database URL errors are explicit and redact the rejected value", (): void => {
  const sentinel: string = "invalid-database-password";
  const malformedUrl: string = ["postgresql://user:", sentinel, "@["].join("");
  expect((): URL => parseDatabaseUrl(malformedUrl)).toThrow(
    "The configured Postgres database URL is invalid",
  );
  try {
    parseDatabaseUrl(malformedUrl);
    throw new Error("Malformed URL unexpectedly parsed");
  } catch (error: unknown) {
    expect(String(error)).not.toContain(sentinel);
  }
});

test("domain storage errors preserve names, context, and causes", (): void => {
  const cause: Error = new Error("invalid row");
  const corruption: StorageCorruptionError = new StorageCorruptionError("message", cause);
  expect(corruption.name).toBe("StorageCorruptionError");
  expect(corruption.message).toBe("Stored message failed runtime validation");
  expect(corruption.cause).toBe(cause);

  const unsupported: UnsupportedDatabaseError = new UnsupportedDatabaseError("https:");
  expect(unsupported.name).toBe("UnsupportedDatabaseError");
  expect(unsupported.message).toContain("postgresql:");
  expect(unsupported.message).toContain("sqlite:");
});

test("hosted startup configuration failures preserve operational error classes", async (): Promise<void> => {
  await expect(createHostedAuthenticator({ MURMUR_AUTH_MODE: "invalid" })).rejects.toThrow(
    InvalidHostedAuthModeError,
  );
  await expect(createHostedAuthenticator({ MURMUR_TENANT_CONTRACT_VERSION: "3" })).rejects.toThrow(
    InvalidTenantContractVersionError,
  );
  await expect(createHostedAuthenticator({ MURMUR_ALLOW_BOOTSTRAP: "yes" })).rejects.toThrow(
    InvalidBootstrapFlagError,
  );
  await expect(
    createHostedAuthenticator({
      MURMUR_ALLOW_BOOTSTRAP: "1",
      MURMUR_API_TOKEN: "legacy-token",
      MURMUR_AUTH_MODE: "legacy",
    }),
  ).rejects.toThrow(InvalidBootstrapConfigurationError);
  await expect(createHostedAuthenticator({ MURMUR_AUTH_MODE: "multi-tenant" })).rejects.toThrow(
    MissingHostedDatabaseError,
  );
  await expect(createHostedAuthenticator({ MURMUR_AUTH_MODE: "legacy" })).rejects.toThrow(
    MissingLegacyApiTokenError,
  );
});

test("HTTP configuration parses every bound and normalizes origins", (): void => {
  const config: HttpServerConfig = parseHttpServerConfig({
    MURMUR_ALLOWED_ORIGINS: " https://one.example, ,https://two.example ",
    MURMUR_AUTHENTICATION_WAIT_MS: "11",
    MURMUR_HTTP_HOST: "127.0.0.1",
    MURMUR_MAX_ACTIVE_REQUESTS: "12",
    MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "13",
    MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "14",
    MURMUR_MAX_ACTIVE_STREAMS: "15",
    MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "16",
    MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "17",
    MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "18",
    MURMUR_MAX_PENDING_AUTHENTICATIONS: "19",
    MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT: "20",
    MURMUR_MAX_REQUEST_BYTES: "21",
    MURMUR_MAX_SESSIONS: "22",
    MURMUR_MAX_SESSIONS_PER_TENANT: "23",
    MURMUR_RATE_LIMIT_PER_MINUTE: "24",
    MURMUR_REGISTRATION_RATE_LIMIT_PER_MINUTE: "25",
    MURMUR_SESSION_IDLE_MS: "26",
    MURMUR_TENANT_RATE_LIMIT_PER_MINUTE: "27",
    PORT: "28",
  });
  expect([...config.allowedOrigins]).toEqual(["https://one.example", "https://two.example"]);
  expect(config).toMatchObject({
    authenticationWaitMs: 11,
    hostname: "127.0.0.1",
    maxActiveRequests: 12,
    maxActiveRequestsPerPrincipal: 13,
    maxActiveRequestsPerTenant: 14,
    maxActiveStreams: 15,
    maxActiveStreamsPerPrincipal: 16,
    maxActiveStreamsPerTenant: 17,
    maxAuthentications: 18,
    maxPendingAuthentications: 19,
    maxPendingAuthenticationsPerTenant: 20,
    maxRequestBytes: 21,
    maxSessions: 22,
    maxSessionsPerTenant: 23,
    rateLimitPerMinute: 24,
    registrationRateLimitPerMinute: 25,
    requestedPort: 28,
    sessionIdleMs: 26,
    tenantRateLimitPerMinute: 27,
  });
  expect((): HttpServerConfig => parseHttpServerConfig({ PORT: "65536" })).toThrow();
  expect(
    (): HttpServerConfig => parseHttpServerConfig({ MURMUR_MAX_REQUEST_BYTES: "0" }),
  ).toThrow();
  expect(
    (): HttpServerConfig => parseHttpServerConfig({ MURMUR_MAX_ACTIVE_STREAMS: "0" }),
  ).toThrow();
  expect(
    (): HttpServerConfig =>
      parseHttpServerConfig({ MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "1.5" }),
  ).toThrow();
  expect(
    (): HttpServerConfig =>
      parseHttpServerConfig({ MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "not-a-number" }),
  ).toThrow();
  expect(
    (): HttpServerConfig =>
      parseHttpServerConfig({ MURMUR_REGISTRATION_RATE_LIMIT_PER_MINUTE: "0" }),
  ).toThrow();
});

test("store selection supports explicit paths and rejects unsupported protocols", async (): Promise<void> => {
  const root: string = mkdtempSync(join(tmpdir(), "murmur-store-selection-"));
  try {
    const configuredStore: MessageStore = await createStore({
      MURMUR_DB_PATH: join(root, "configured", "messages.db"),
    });
    await configuredStore.close();

    const fileStore: MessageStore = await createStore({
      MURMUR_DATABASE_URL: pathToFileURL(join(root, "file-url", "messages.db")).toString(),
    });
    await fileStore.close();

    const sqliteStore: MessageStore = await createStore({
      MURMUR_DATABASE_URL: `sqlite:${join(root, "sqlite-url", "messages.db")}`,
    });
    await sqliteStore.close();

    await expect(createStore({ MURMUR_DATABASE_URL: "https://database.example" })).rejects.toThrow(
      UnsupportedDatabaseError,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("SQLite scope and shutdown boundaries fail closed", (): void => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
  expect(store.scope(TenantId.founding())).toBe(store);
  expect(
    (): MessageStore => store.scope(TenantId.parse("00000000-0000-4000-8000-000000000002")),
  ).toThrow("SQLite storage supports only the founding tenant");
  expect((): unknown =>
    store.scopeE2ee(TenantId.parse("00000000-0000-4000-8000-000000000002")),
  ).toThrow("SQLite storage supports only the founding tenant");
  const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
  expect(
    (): E2eeMessageStore =>
      encrypted.scopeE2ee(TenantId.parse("00000000-0000-4000-8000-000000000002")),
  ).toThrow("SQLite storage supports only the founding tenant");
  store.close();
  store.close();
  expect((): unknown => store.getAgent(AgentId.parse("closed-agent"))).toThrow(
    "The message store is closed",
  );
});
