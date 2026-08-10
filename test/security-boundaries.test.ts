import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";

import {
  BoundedJsonObjectSchema,
  JsonObjectSchema,
  type JsonObject,
} from "../src/domain/value-objects.js";
import {
  ConflictingDatabaseTlsConfigurationError,
  DatabaseCertificateAuthorityReadError,
  InvalidDatabaseTlsModeError,
  postgresSslOptions,
  postgresTlsConfiguration,
  type PostgresTlsConfiguration,
} from "../src/postgres-tls.js";
import {
  credentialAdmissionKey,
  databaseCredentialHint,
  hashTokenSecret,
  parseOperatorTokenSecret,
} from "../src/hosted/token-secret.js";

function databaseUrl(hostname: string): string {
  const url: URL = new URL("postgresql://database.example:5432/postgres");
  url.hostname = hostname;
  url.username = "user";
  url.password = "secret";
  return url.toString();
}

test("production adoption rejects a legacy token that strict auth cannot parse", async (): Promise<void> => {
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, "run", "scripts/bootstrap-production.ts"],
    {
      env: {
        MURMUR_BOOTSTRAP_URL: "https://murmur.invalid/mcp",
        MURMUR_INITIAL_OPERATOR_TOKEN: `mur_op_operator_${"a".repeat(43)}`,
        MURMUR_LEGACY_TOKEN: "legacy-token-with-an-unsupported-wire-format",
        PATH: process.env["PATH"] ?? "",
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    },
  );
  const exitCode: number = await child.exited;
  const stderr: string = await new Response(child.stderr).text();
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('"context":"Murmur production bootstrap failed"');
  expect(stderr).toContain('"error_class":"LegacyTokenFormatError"');
  expect(stderr).not.toContain("legacy-token-with-an-unsupported-wire-format");
});

test("operator token parsing preserves base64url key identifiers", (): void => {
  const secret: string = `mur_op_key_with_under_score_${"a".repeat(43)}`;
  expect(parseOperatorTokenSecret(secret)).toEqual({
    hash: hashTokenSecret(secret),
    keyId: "key_with_under_score",
    secret,
  });
});

test("credential admission hints cover first-use and adopted legacy tokens", (): void => {
  const activeToken: string = `mur_tenant01_${"a".repeat(43)}`;
  const wrongSecretWithSameKey: string = `mur_tenant01_${"z".repeat(43)}`;
  expect(credentialAdmissionKey(activeToken)).not.toBe(
    credentialAdmissionKey(wrongSecretWithSameKey),
  );
  expect(databaseCredentialHint(activeToken)).toEqual({
    keyId: "tenant01",
    principalKind: "tenant",
  });
  expect(databaseCredentialHint(`mur_op_operator01_${"b".repeat(43)}`)).toEqual({
    keyId: "operator01",
    principalKind: "operator",
  });
  expect(databaseCredentialHint(`mur_boot_bootstrap01_${"c".repeat(43)}`)).toEqual({
    keyId: "bootstrap01",
    principalKind: "bootstrap",
  });
  const legacyToken: string = "d".repeat(64);
  expect(databaseCredentialHint(legacyToken)).toEqual({
    keyId: `legacy_${hashTokenSecret(legacyToken).toString("base64url").slice(0, 12)}`,
    principalKind: "tenant",
  });
  expect(databaseCredentialHint("not-a-credential")).toBeNull();
});

test("metadata input bounds protect writes without breaking legacy stored rows", (): void => {
  const valid: JsonObject = {
    nested: { one: { two: { three: "value" } } },
    values: Array.from({ length: 100 }, (_value: unknown, index: number): number => index),
  };
  expect(BoundedJsonObjectSchema.parse(valid)).toEqual(valid);

  expect(BoundedJsonObjectSchema.safeParse({ payload: "x".repeat(16 * 1024) }).success).toBe(false);
  expect(
    BoundedJsonObjectSchema.safeParse({ one: { two: { three: { four: { five: true } } } } })
      .success,
  ).toBe(false);
  expect(BoundedJsonObjectSchema.safeParse({ values: Array.from({ length: 101 }) }).success).toBe(
    false,
  );
  expect(
    BoundedJsonObjectSchema.safeParse(
      Object.fromEntries(
        Array.from({ length: 101 }, (_value: unknown, index: number): [string, number] => [
          `key-${index}`,
          index,
        ]),
      ),
    ).success,
  ).toBe(false);
  expect(BoundedJsonObjectSchema.safeParse({ ["k".repeat(201)]: true }).success).toBe(false);

  const formerlyValidStoredMetadata: JsonObject = { payload: "x".repeat(20 * 1024) };
  expect(JsonObjectSchema.parse(formerlyValidStoredMetadata)).toEqual(formerlyValidStoredMetadata);
});

test("database TLS verifies peers unless insecure mode is explicit", (): void => {
  expect(postgresTlsConfiguration({})).toEqual({ mode: "verify-system" });
  expect(
    (): PostgresTlsConfiguration =>
      postgresTlsConfiguration({ MURMUR_DATABASE_TLS_INSECURE: "yes" }),
  ).toThrow(InvalidDatabaseTlsModeError);
  expect(
    postgresTlsConfiguration({ MURMUR_DATABASE_CA_PATH: "", MURMUR_DATABASE_TLS_INSECURE: "1" }),
  ).toEqual({ mode: "insecure" });
  expect(
    (): PostgresTlsConfiguration =>
      postgresTlsConfiguration({
        MURMUR_DATABASE_CA_PATH: "/tmp/not-read-because-conflict.pem",
        MURMUR_DATABASE_TLS_INSECURE: "1",
      }),
  ).toThrow(ConflictingDatabaseTlsConfigurationError);
  expect(
    (): PostgresTlsConfiguration =>
      postgresTlsConfiguration({ MURMUR_DATABASE_CA_PATH: "/definitely/missing/murmur-ca.pem" }),
  ).toThrow(DatabaseCertificateAuthorityReadError);

  expect(
    postgresSslOptions(databaseUrl("database.example.com"), {
      mode: "verify-system",
    }),
  ).toEqual({ rejectUnauthorized: true, servername: "database.example.com" });
  expect(
    postgresSslOptions(databaseUrl("127.0.0.1"), {
      mode: "verify-system",
    }),
  ).toEqual({ rejectUnauthorized: true });
  expect(
    postgresSslOptions(databaseUrl("[::1]"), {
      mode: "verify-system",
    }),
  ).toEqual({ rejectUnauthorized: true });
  expect(
    postgresSslOptions(databaseUrl("database.example.com"), {
      mode: "insecure",
    }),
  ).toBe(false);
});

test("database TLS loads a custom certificate authority in verify-full mode", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-database-ca-"));
  const certificatePath: string = join(directory, "ca.pem");
  try {
    writeFileSync(certificatePath, "test certificate authority\n");
    const configuration: PostgresTlsConfiguration = postgresTlsConfiguration({
      MURMUR_DATABASE_CA_PATH: certificatePath,
    });
    expect(configuration).toEqual({
      certificateAuthority: "test certificate authority\n",
      mode: "verify-full",
    });
    expect(postgresSslOptions(databaseUrl("database.example.com"), configuration)).toEqual({
      ca: "test certificate authority\n",
      rejectUnauthorized: true,
      servername: "database.example.com",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
