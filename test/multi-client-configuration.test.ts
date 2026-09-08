import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureCursorE2eeMcp,
  configureCursorMcp,
  configureFxE2eeMcp,
  configureFxInstructions,
  configureFxMcp,
  configureOpenCodeE2eeMcp,
  configureOpenCodeMcp,
  configurePiE2eeMcp,
  configurePiMcp,
  DEFAULT_MURMUR_URL,
  FX_MURMUR_INSTRUCTIONS,
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
    fxInstructions: join(directory, ".fx", "AGENTS.md"),
    fxMcp: join(directory, ".fx", "mcp.json"),
    opencodeConfig: join(directory, ".config", "opencode", "opencode.json"),
    piMcp: join(directory, ".config", "mcp", "mcp.json"),
  };
}

test("configures hook-free MCP clients without storing a token", (): void => {
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

  const fx: JsonRecord = configureFxMcp(
    { mcp: { unrelated: { command: ["other"] } }, theme: "dark" },
    DEFAULT_MURMUR_URL,
  );
  expect(fx["theme"]).toBe("dark");
  expect(murmurServer(fx, "mcp")).toEqual({
    bearer_token_env: "MURMUR_API_TOKEN",
    enabled: true,
    headers: { "X-Murmur-Client": "fx" },
    type: "http",
    url: DEFAULT_MURMUR_URL,
  });
  expect(requireRecord(fx["mcp"])["unrelated"]).toEqual({ command: ["other"] });

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
  expect(JSON.stringify([opencode, fx, cursor, pi])).not.toContain("must-not-be-written");
});

test("injects the managed fx coordination contract without replacing user instructions", (): void => {
  const existing: string = "# Personal fx instructions\n\nKeep this text.\n";
  const configured: string = configureFxInstructions(existing);
  expect(configured.startsWith(existing)).toBe(true);
  expect(configured).toContain(FX_MURMUR_INSTRUCTIONS);
  expect(configured).toContain('client: "fx"');
  expect(configured).toContain("repository and branch from the current checkout");
  expect(configured).toContain("wait_for_messages");
  expect(configured).toContain("end_session");
  expect(configured).toContain("read only after their content has been handled");
  expect(configureFxInstructions(configured)).toBe(configured);
  expect((): string =>
    configureFxInstructions("<!-- murmur-managed:fx:start -->\ntruncated"),
  ).toThrow("invalid managed Murmur instruction block");
  expect((): string =>
    configureFxInstructions(`${FX_MURMUR_INSTRUCTIONS}\n${FX_MURMUR_INSTRUCTIONS}\n`),
  ).toThrow("multiple managed Murmur instruction blocks");
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

  const fx: JsonRecord = configureFxMcp(
    {
      mcp: {
        murmur: {
          bearer_token_env: "OLD_TOKEN",
          headers: {
            AUTHORIZATION: "Bearer must-not-be-written",
            "X-Custom-Header": "preserved",
            "x-murmur-client": "spoofed-client",
          },
          operation_timeout_ms: 45_000,
          required: true,
          startup_timeout_ms: 15_000,
          type: "http",
          url: DEFAULT_MURMUR_URL,
        },
      },
    },
    DEFAULT_MURMUR_URL,
  );
  expect(murmurServer(fx, "mcp")).toEqual({
    bearer_token_env: "MURMUR_API_TOKEN",
    enabled: true,
    headers: { "X-Custom-Header": "preserved", "X-Murmur-Client": "fx" },
    operation_timeout_ms: 45_000,
    required: true,
    startup_timeout_ms: 15_000,
    type: "http",
    url: DEFAULT_MURMUR_URL,
  });
  expect(JSON.stringify(fx)).not.toContain("OLD_TOKEN");
  expect(JSON.stringify(fx)).not.toContain("must-not-be-written");
  expect(JSON.stringify(fx)).not.toContain("spoofed");

  const invalidFxOptions: JsonRecord = configureFxMcp(
    {
      mcp: {
        murmur: {
          operation_timeout_ms: -1,
          required: "yes",
          startup_timeout_ms: 1.5,
          type: "http",
          url: DEFAULT_MURMUR_URL,
        },
      },
    },
    DEFAULT_MURMUR_URL,
  );
  expect(murmurServer(invalidFxOptions, "mcp")).toEqual({
    bearer_token_env: "MURMUR_API_TOKEN",
    enabled: true,
    headers: { "X-Murmur-Client": "fx" },
    type: "http",
    url: DEFAULT_MURMUR_URL,
  });
});

test("upgrades bootstrap entries, remains idempotent, and protects conflicting servers", (): void => {
  const bootstrap: string = "https://api.usemurmur.dev/setup/mcp";
  const openCurrent: JsonRecord = {
    mcp: { murmur: { enabled: true, type: "remote", url: bootstrap } },
  };
  const openConfigured: JsonRecord = configureOpenCodeMcp(openCurrent, DEFAULT_MURMUR_URL);
  expect(murmurServer(openConfigured, "mcp")["url"]).toBe(DEFAULT_MURMUR_URL);
  expect(configureOpenCodeMcp(openConfigured, DEFAULT_MURMUR_URL)).toEqual(openConfigured);

  const fxCurrent: JsonRecord = {
    mcp: { murmur: { enabled: true, type: "http", url: bootstrap } },
  };
  const fxConfigured: JsonRecord = configureFxMcp(fxCurrent, DEFAULT_MURMUR_URL);
  expect(configureFxMcp(fxConfigured, DEFAULT_MURMUR_URL)).toEqual(fxConfigured);

  const fxAlias: JsonRecord = configureFxMcp(
    {
      mcpServers: {
        murmur: { enabled: true, type: "http", url: bootstrap },
        sibling: { command: ["preserved"] },
      },
    },
    DEFAULT_MURMUR_URL,
  );
  expect(fxAlias["mcpServers"]).toBeUndefined();
  expect(requireRecord(fxAlias["mcp"])["sibling"]).toEqual({ command: ["preserved"] });
  expect(configureFxMcp(fxAlias, DEFAULT_MURMUR_URL)).toEqual(fxAlias);

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
      configureFxMcp(
        { mcp: { murmur: { type: "http", url: "https://different.example/mcp" } } },
        DEFAULT_MURMUR_URL,
      ),
  ).toThrow("--replace");
  expect(
    murmurServer(
      configureFxMcp(
        { mcp: { murmur: { command: ["other"], type: "local" } } },
        DEFAULT_MURMUR_URL,
        true,
      ),
      "mcp",
    ),
  ).toEqual({
    bearer_token_env: "MURMUR_API_TOKEN",
    enabled: true,
    headers: { "X-Murmur-Client": "fx" },
    type: "http",
    url: DEFAULT_MURMUR_URL,
  });
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
  const fx: JsonRecord = configureFxE2eeMcp({}, DEFAULT_MURMUR_URL, PROXY, false, vault);
  expect(murmurServer(fx, "mcp")).toEqual({
    command: [PROXY, ...argumentsFor("fx")],
    enabled: true,
    type: "local",
  });
  const pi: JsonRecord = configurePiE2eeMcp({}, DEFAULT_MURMUR_URL, PROXY, false, vault);
  expect(murmurServer(pi, "mcpServers")).toEqual({
    args: argumentsFor("pi"),
    command: PROXY,
  });
  expect(JSON.stringify([opencode, cursor, fx, pi])).not.toContain("Authorization");
  expect(JSON.stringify([opencode, cursor, fx, pi])).not.toContain("bearerTokenEnv");
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
    { client: "fx", configure: configureFxE2eeMcp, rootKey: "mcp" },
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

test("installs all six targets atomically and does not require hooks for other clients", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-multi-client-"));
  const paths: UserConfigurationPaths = configurationPaths(directory);
  try {
    mkdirSync(join(directory, ".cursor"), { recursive: true });
    writeFileSync(paths.cursorMcp, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    const changed: readonly string[] = installUserConfiguration({
      clients: ["claude", "codex", "fx", "opencode", "cursor", "pi"],
      hookExecutable: "/usr/local/bin/murmur-hook",
      paths,
    });
    expect(changed).toHaveLength(9);
    expect(readFileSync(paths.fxInstructions, "utf8")).toContain("Murmur coordination for fx");
    expect(readFileSync(paths.cursorMcp, "utf8")).toContain('"other"');
    expect(
      installUserConfiguration({
        clients: ["claude", "codex", "fx", "opencode", "cursor", "pi"],
        hookExecutable: "/usr/local/bin/murmur-hook",
        paths,
      }),
    ).toEqual([]);

    const otherDirectory: string = join(directory, "without-hooks");
    const otherPaths: UserConfigurationPaths = configurationPaths(otherDirectory);
    expect(
      installUserConfiguration({ clients: ["fx", "opencode", "cursor", "pi"], paths: otherPaths }),
    ).toHaveLength(5);
    expect(existsSync(otherPaths.fxMcp)).toBe(true);
    expect(existsSync(otherPaths.fxInstructions)).toBe(true);
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

    const fxPaths: UserConfigurationPaths = configurationPaths(join(directory, "fx-conflict"));
    mkdirSync(join(directory, "fx-conflict", ".fx"), { recursive: true });
    writeFileSync(fxPaths.fxInstructions, "<!-- murmur-managed:fx:start -->\ntruncated\n");
    expect((): readonly string[] =>
      installUserConfiguration({ clients: ["fx"], paths: fxPaths }),
    ).toThrow("invalid managed Murmur instruction block");
    expect(existsSync(fxPaths.fxMcp)).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
