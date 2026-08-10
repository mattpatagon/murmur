import { expect, test } from "bun:test";

import {
  buildRuntimeDatabaseUrl,
  runtimeDatabaseUrlKind,
  runtimePasswordFromDatabaseUrl,
  runtimeUsername,
} from "../scripts/provision-runtime-database.js";

const RuntimePassword: string = "runtime-password-with-32-bytes-minimum";

function databaseUrl(
  username: string,
  password: string,
  hostname: string = "db.example.test",
  protocol: "https:" | "postgresql:" = "postgresql:",
): string {
  const url: URL = new URL(`${protocol}//${hostname}:5432/postgres`);
  url.username = username;
  url.password = encodeURIComponent(password);
  return url.toString();
}

test("runtime database usernames preserve Supabase pooler suffixes", (): void => {
  expect(runtimeUsername("postgres")).toBe("murmur_app");
  expect(runtimeUsername("postgres.project-ref_1")).toBe("murmur_app.project-ref_1");
});

test("runtime database URLs are derived without changing their endpoint", (): void => {
  const direct: URL = new URL(
    buildRuntimeDatabaseUrl(databaseUrl("postgres", "admin"), RuntimePassword),
  );
  expect(direct.username).toBe("murmur_app");
  expect(decodeURIComponent(direct.password)).toBe(RuntimePassword);
  expect(direct.host).toBe("db.example.test:5432");

  const pooler: URL = new URL(
    buildRuntimeDatabaseUrl(
      `${databaseUrl("postgres.project-ref", "admin", "pooler.example.test")}?sslmode=verify-full`,
      RuntimePassword,
    ),
  );
  expect(pooler.username).toBe("murmur_app.project-ref");
  expect(pooler.searchParams.get("sslmode")).toBe("verify-full");
});

test("runtime database credential inspection distinguishes templates without connecting", (): void => {
  expect(runtimeDatabaseUrlKind(databaseUrl("postgres", "admin"))).toBe("template");
  expect(runtimeDatabaseUrlKind(databaseUrl("murmur_app", RuntimePassword))).toBe("runtime");
  expect(
    runtimeDatabaseUrlKind(
      databaseUrl("murmur_app.project-ref", RuntimePassword, "pooler.example.test"),
    ),
  ).toBe("runtime");
});

test("staged runtime passwords can be recovered exactly after URL encoding", (): void => {
  const password: string = "runtime:%/password?#-with-32-bytes-minimum";
  const stagedDatabaseUrl: string = buildRuntimeDatabaseUrl(
    databaseUrl("postgres", "admin"),
    password,
  );
  expect(runtimePasswordFromDatabaseUrl(stagedDatabaseUrl)).toBe(password);
});

test("runtime credential inspection rejects malformed staged credentials", (): void => {
  expect((): string => runtimeDatabaseUrlKind(databaseUrl("murmur_app", "short"))).toThrow(
    "at least 32 bytes",
  );
  expect((): string =>
    runtimePasswordFromDatabaseUrl(databaseUrl("postgres", RuntimePassword)),
  ).toThrow("not a murmur_app runtime credential");
  expect((): "runtime" | "template" =>
    runtimeDatabaseUrlKind(databaseUrl("murmur_app", RuntimePassword, "db.example.test", "https:")),
  ).toThrow("must use postgres or postgresql");
});
