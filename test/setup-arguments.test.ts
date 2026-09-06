import { expect, test } from "bun:test";

import { parseSetupArguments, setupIncludesPi } from "../src/setup/setup-arguments.js";

test("setup defaults to every supported client and reports the Pi prerequisite", (): void => {
  const parsed: ReturnType<typeof parseSetupArguments> = parseSetupArguments(["--user"]);
  expect(parsed.clients).toEqual(["claude", "codex", "opencode", "cursor", "pi"]);
  expect(setupIncludesPi(["--user"])).toBe(true);
});

test("setup accepts and deduplicates every explicit client selector", (): void => {
  const parsed: ReturnType<typeof parseSetupArguments> = parseSetupArguments([
    "--user",
    "--cursor",
    "--opencode",
    "--pi",
    "--claude",
    "--codex",
    "--cursor",
  ]);
  expect(parsed.clients).toEqual(["cursor", "opencode", "pi", "claude", "codex"]);
  expect(setupIncludesPi(["--user", "--cursor"])).toBe(false);
  expect(setupIncludesPi(["--user", "--pi"])).toBe(true);
});

test("setup preserves option validation for new and existing targets", (): void => {
  expect((): ReturnType<typeof parseSetupArguments> => parseSetupArguments(["--opencode"])).toThrow(
    "--user",
  );
  expect(
    (): ReturnType<typeof parseSetupArguments> => parseSetupArguments(["--user", "--url"]),
  ).toThrow("requires a value");
  expect(
    (): ReturnType<typeof parseSetupArguments> =>
      parseSetupArguments(["--user", "--url", "http://remote.example/mcp"]),
  ).toThrow("must use HTTPS");
  expect(
    (): ReturnType<typeof parseSetupArguments> =>
      parseSetupArguments(["--user", "--e2ee", "--vault-path", "relative.sqlite"]),
  ).toThrow("absolute path");
});
