import { resolve } from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";

import { safeErrorMessage } from "../src/safe-errors.js";

test("malformed MURMUR_DATABASE_URL never exposes its password", async (): Promise<void> => {
  const sentinel: string = "DATABASE_PASSWORD_SENTINEL";
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, "run", "src/http-server.ts"],
    {
      cwd: resolve("."),
      env: {
        MURMUR_DATABASE_URL: `postgresql://murmur:${sentinel}@[invalid`,
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

test("safe errors redact Postgres URL credentials", (): void => {
  const sentinel: string = "DATABASE_PASSWORD_SENTINEL";
  const message: string = safeErrorMessage(
    new Error(`connection refused for postgresql://murmur:${sentinel}@database.example/murmur`),
  );
  expect(message).toContain("postgresql://[redacted]@database.example/murmur");
  expect(message).not.toContain(sentinel);
});
