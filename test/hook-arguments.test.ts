import { expect, test } from "bun:test";

import { parseHookArguments } from "../src/hook-arguments.js";

test("parses plain and E2E hook arguments", (): void => {
  expect(parseHookArguments(["--client", "codex"])).toEqual({
    client: "codex",
    e2ee: false,
    vaultPath: null,
  });
  expect(
    parseHookArguments([
      "--vault-path",
      "/var/lib/murmur/custom vault.sqlite",
      "--client",
      "claude",
      "--e2ee",
    ]),
  ).toEqual({
    client: "claude",
    e2ee: true,
    vaultPath: "/var/lib/murmur/custom vault.sqlite",
  });
});

test("rejects incomplete, unknown, and unsafe hook arguments", (): void => {
  const invalidArguments: readonly (readonly string[])[] = [
    [],
    ["--client"],
    ["--client", "other"],
    ["--unknown"],
    ["--client", "codex", "--vault-path"],
    ["--client", "codex", "--vault-path", "--e2ee"],
    ["--client", "codex", "--vault-path", "/tmp/vault.sqlite"],
    ["--client", "codex", "--e2ee", "--vault-path", "relative.sqlite"],
  ];
  for (const arguments_ of invalidArguments) {
    expect((): unknown => parseHookArguments(arguments_)).toThrow("Usage: murmur-hook");
  }
});
