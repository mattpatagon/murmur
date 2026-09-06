import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureCursorE2eeMcp,
  configureCursorMcp,
  configureOpenCodeE2eeMcp,
  configureOpenCodeMcp,
  configurePiE2eeMcp,
  configurePiMcp,
  DEFAULT_MURMUR_URL,
  installUserConfiguration,
  type UserConfigurationPaths,
} from "../src/setup/user-configuration.js";

type JsonRecord = Record<string, unknown>;

const PROXY: string = "/usr/local/bin/murmur-e2ee-proxy";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function murmurServer(configuration: JsonRecord, rootKey: "mcp" | "mcpServers"): JsonRecord {
  return requireRecord(requireRecord(configuration[rootKey])["murmur"]);
}

function configurationPaths(directory: string): UserConfigurationPaths {
  return {
    claudeMcp: join(directory, ".claude.json"),
    claudeSettings: join(directory, ".claude", "settings.json"),
    codexConfig: join(directory, ".codex", "config.toml"),
    codexHooks: join(directory, ".codex", "hooks.json"),
    cursorMcp: join(directory, ".cursor", "mcp.json"),
    opencodeConfig: join(directory, ".config", "opencode", "opencode.json"),
    piMcp: join(directory, ".config", "mcp", "mcp.json"),
  };
}

test("configures OpenCode, Cursor, and the Pi adapter without storing a token", (): void => {
  const opencode: JsonRecord = configureOpenCodeMcp(
    { mcp: { unrelated: { command: ["other"] } }, theme: "dark" },
    DEFAULT_MURMUR_URL,
  );
  expect(opencode["theme"]).toBe("dark");
  expect(murmurServer(opencode, "mcp")).toEqual({
    enabled: true,
    headers: {
      Authorization: "Bearer {env:MURMUR_API_TOKEN}",
      "X-Murmur-Client": "opencode",
    },
    oauth: false,
    type: "remote",
    url: DEFAULT_MURMUR_URL,
  });
  expect(requireRecord(opencode["mcp"])["unrelated"]).toEqual({ command: ["other"] });

  const cursor: JsonRecord = configureCursorMcp({}, DEFAULT_MURMUR_URL);
  expect(murmurServer(cursor, "mcpServers")).toEqual({
    headers: {
      Authorization: `Bearer \${env:MURMUR_API_TOKEN}`,
      "X-Murmur-Client": "cursor",
    },
    url: DEFAULT_MURMUR_URL,
  });

  const pi: JsonRecord = configurePiMcp({}, DEFAULT_MURMUR_URL);
  expect(murmurServer(pi, "mcpServers")).toEqual({
    auth: "bearer",
    bearerTokenEnv: "MURMUR_API_TOKEN",
    headers: { "X-Murmur-Client": "pi" },
    url: DEFAULT_MURMUR_URL,
  });
  expect(JSON.stringify([opencode, cursor, pi])).not.toContain("must-not-be-written");
});

test("replaces managed headers regardless of casing and preserves unrelated headers", (): void => {
  const configured: JsonRecord = configureCursorMcp(
    {
      mcpServers: {
        murmur: {
          headers: {
            AUTHORIZATION: "Bearer must-not-be-written",
            "X-Custom-Header": "preserved",
            "x-murmur-client": "spoofed-client",
            "x-MuRmUr-RePoSiToRy": "spoofed-repository",
          },
          url: DEFAULT_MURMUR_URL,
        },
      },
    },
    DEFAULT_MURMUR_URL,
  );
  expect(murmurServer(configured, "mcpServers")["headers"]).toEqual({
    Authorization: `Bearer \${env:MURMUR_API_TOKEN}`,
    "X-Custom-Header": "preserved",
    "X-Murmur-Client": "cursor",
  });
  expect(JSON.stringify(configured)).not.toContain("must-not-be-written");
  expect(JSON.stringify(configured)).not.toContain("spoofed");
});

test("upgrades bootstrap entries, remains idempotent, and protects conflicting servers", (): void => {
  const bootstrap: string = "https://api.usemurmur.dev/setup/mcp";
  const openCurrent: JsonRecord = {
    mcp: { murmur: { enabled: true, type: "remote", url: bootstrap } },
  };
  const openConfigured: JsonRecord = configureOpenCodeMcp(openCurrent, DEFAULT_MURMUR_URL);
  expect(murmurServer(openConfigured, "mcp")["url"]).toBe(DEFAULT_MURMUR_URL);
  expect(configureOpenCodeMcp(openConfigured, DEFAULT_MURMUR_URL)).toEqual(openConfigured);

  const cursorCurrent: JsonRecord = { mcpServers: { murmur: { url: bootstrap } } };
  const cursorConfigured: JsonRecord = configureCursorMcp(cursorCurrent, DEFAULT_MURMUR_URL);
  expect(configureCursorMcp(cursorConfigured, DEFAULT_MURMUR_URL)).toEqual(cursorConfigured);

  const piCurrent: JsonRecord = { mcpServers: { murmur: { url: bootstrap } } };
  const piConfigured: JsonRecord = configurePiMcp(piCurrent, DEFAULT_MURMUR_URL);
  expect(configurePiMcp(piConfigured, DEFAULT_MURMUR_URL)).toEqual(piConfigured);

  const conflict: JsonRecord = {
    mcpServers: { murmur: { url: "https://different.example/mcp" } },
  };
  expect((): JsonRecord => configureCursorMcp(conflict, DEFAULT_MURMUR_URL)).toThrow("--replace");
  expect((): JsonRecord => configurePiMcp(conflict, DEFAULT_MURMUR_URL)).toThrow("--replace");
  expect(
    (): JsonRecord =>
      configureOpenCodeMcp(
        { mcp: { murmur: { type: "remote", url: "https://different.example/mcp" } } },
        DEFAULT_MURMUR_URL,
      ),
  ).toThrow("--replace");
});

test("configures each E2E entry with its supported local command shape", (): void => {
  const vault: string = "/private/murmur vault/vault.sqlite";
  const argumentsFor: (client: string) => readonly string[] = (
    client: string,
  ): readonly string[] => ["--url", DEFAULT_MURMUR_URL, "--client", client, "--vault-path", vault];
  const opencode: JsonRecord = configureOpenCodeE2eeMcp(
    {},
    DEFAULT_MURMUR_URL,
    PROXY,
    false,
    vault,
  );
  expect(murmurServer(opencode, "mcp")).toEqual({
    command: [PROXY, ...argumentsFor("opencode")],
    enabled: true,
    type: "local",
  });
  const cursor: JsonRecord = configureCursorE2eeMcp({}, DEFAULT_MURMUR_URL, PROXY, false, vault);
  expect(murmurServer(cursor, "mcpServers")).toEqual({
    args: argumentsFor("cursor"),
    command: PROXY,
    env: { MURMUR_API_TOKEN: `\${env:MURMUR_API_TOKEN}` },
  });
  const pi: JsonRecord = configurePiE2eeMcp({}, DEFAULT_MURMUR_URL, PROXY, false, vault);
  expect(murmurServer(pi, "mcpServers")).toEqual({
    args: argumentsFor("pi"),
    command: PROXY,
  });
  expect(JSON.stringify([opencode, cursor, pi])).not.toContain("Authorization");
  expect(JSON.stringify([opencode, cursor, pi])).not.toContain("bearerTokenEnv");
});

test("keeps local E2E setup repeatable and recovers conflicts only with replace", (): void => {
  type LocalConfigurator = (
    current: JsonRecord,
    url: string,
    executable: string,
    replace?: boolean | undefined,
    vaultPath?: string | undefined,
  ) => JsonRecord;
  const fixtures: readonly {
    readonly client: string;
    readonly configure: LocalConfigurator;
    readonly rootKey: "mcp" | "mcpServers";
  }[] = [
    { client: "opencode", configure: configureOpenCodeE2eeMcp, rootKey: "mcp" },
    { client: "cursor", configure: configureCursorE2eeMcp, rootKey: "mcpServers" },
    { client: "pi", configure: configurePiE2eeMcp, rootKey: "mcpServers" },
  ];
  for (const fixture of fixtures) {
    const configured: JsonRecord = fixture.configure({}, DEFAULT_MURMUR_URL, PROXY);
    expect(fixture.configure(configured, DEFAULT_MURMUR_URL, PROXY)).toEqual(configured);
    const bootstrap: JsonRecord = {
      [fixture.rootKey]: {
        murmur: { url: "https://api.usemurmur.dev/setup/mcp" },
        sibling: { command: "preserved" },
      },
    };
    const upgraded: JsonRecord = fixture.configure(bootstrap, DEFAULT_MURMUR_URL, PROXY);
    expect(requireRecord(upgraded[fixture.rootKey])["sibling"]).toEqual({ command: "preserved" });
    const conflict: JsonRecord = {
      [fixture.rootKey]: { murmur: { command: "other", args: [fixture.client] } },
    };
    expect((): JsonRecord => fixture.configure(conflict, DEFAULT_MURMUR_URL, PROXY)).toThrow(
      "--replace",
    );
    expect(fixture.configure(conflict, DEFAULT_MURMUR_URL, PROXY, true)).toEqual(configured);
    expect(
      (): JsonRecord => fixture.configure({ [fixture.rootKey]: [] }, DEFAULT_MURMUR_URL, PROXY),
    ).toThrow("--replace");
  }
});

test("installs all five targets atomically and does not require hooks for other clients", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-multi-client-"));
  const paths: UserConfigurationPaths = configurationPaths(directory);
  try {
    mkdirSync(join(directory, ".cursor"), { recursive: true });
    writeFileSync(paths.cursorMcp, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    const changed: readonly string[] = installUserConfiguration({
      clients: ["claude", "codex", "opencode", "cursor", "pi"],
      hookExecutable: "/usr/local/bin/murmur-hook",
      paths,
    });
    expect(changed).toHaveLength(7);
    expect(readFileSync(paths.cursorMcp, "utf8")).toContain('"other"');
    expect(
      installUserConfiguration({
        clients: ["claude", "codex", "opencode", "cursor", "pi"],
        hookExecutable: "/usr/local/bin/murmur-hook",
        paths,
      }),
    ).toEqual([]);

    const otherDirectory: string = join(directory, "without-hooks");
    const otherPaths: UserConfigurationPaths = configurationPaths(otherDirectory);
    expect(
      installUserConfiguration({ clients: ["opencode", "cursor", "pi"], paths: otherPaths }),
    ).toHaveLength(3);
    expect(existsSync(otherPaths.opencodeConfig)).toBe(true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("validates every selected native target before writing any file", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-multi-client-conflict-"));
  const paths: UserConfigurationPaths = configurationPaths(directory);
  try {
    mkdirSync(join(directory, ".config", "mcp"), { recursive: true });
    writeFileSync(
      paths.piMcp,
      JSON.stringify({ mcpServers: { murmur: { url: "https://different.example/mcp" } } }),
    );
    expect((): readonly string[] =>
      installUserConfiguration({ clients: ["opencode", "pi"], paths }),
    ).toThrow("--replace");
    expect(existsSync(paths.opencodeConfig)).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
