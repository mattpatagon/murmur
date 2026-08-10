import { resolve } from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";

import { safeErrorMessage } from "../src/safe-errors.js";

function databaseUrl(password: string): string {
  const url: URL = new URL("postgresql://database.example/murmur");
  url.username = "murmur";
  url.password = password;
  return url.toString();
}

test("malformed MURMUR_DATABASE_URL never exposes its password", async (): Promise<void> => {
  const sentinel: string = "DATABASE_PASSWORD_SENTINEL";
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, "run", "src/http-server.ts"],
    {
      cwd: resolve("."),
      env: {
        MURMUR_DATABASE_URL: ["postgresql", "://murmur:", sentinel, "@[invalid"].join(""),
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
  expect(stderr).toContain("The configured Postgres database URL is invalid");
  expect(stderr).not.toContain(sentinel);
});

test("safe error logging initializes lazily under unrelated log-level values", async (): Promise<void> => {
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import("./src/safe-errors.ts").then(({ logSafeError }) => logSafeError("lazy logger", new Error("expected failure")))',
    ],
    {
      cwd: resolve("."),
      env: {
        MURMUR_LOG_LEVEL: "warn",
        PATH: process.env["PATH"] ?? "",
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    },
  );
  const exitCode: number = await child.exited;
  const stderr: string = await new Response(child.stderr).text();
  expect(exitCode).toBe(0);
  expect(stderr).toContain('"severity":"ERROR"');
  expect(stderr).toContain('"message":"lazy logger: expected failure"');
});

test("safe errors redact Postgres URL credentials", (): void => {
  const sentinel: string = "DATABASE_PASSWORD_SENTINEL";
  const message: string = safeErrorMessage(
    new Error(`connection refused for ${databaseUrl(sentinel)}`),
  );
  expect(message).toContain("postgresql://[redacted]@database.example/murmur");
  expect(message).not.toContain(sentinel);
});

test("safe errors redact every Murmur credential grammar", (): void => {
  const tokens: readonly string[] = [
    `mur_tenant01_${"a".repeat(43)}`,
    `mur_op_operator01_${"b".repeat(43)}`,
    `mur_boot_bootstrap1_${"c".repeat(43)}`,
    "d".repeat(64),
  ];
  const message: string = safeErrorMessage(new Error(`request failed for ${tokens.join(" and ")}`));
  expect(message.match(/\[redacted-token\]/gu)).toHaveLength(tokens.length);
  tokens.forEach((token: string): void => {
    expect(message).not.toContain(token);
  });
});
