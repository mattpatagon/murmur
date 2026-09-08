import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureOmpE2eeMcp,
  configureOmpExtension,
  configureOmpMcp,
  DEFAULT_MURMUR_URL,
  defaultUserConfigurationPaths,
  installUserConfiguration,
  OMP_EXTENSION_MARKER,
  ompExtensionSource,
  ompHookCommand,
  type UserConfigurationPaths,
} from "../src/setup/user-configuration.js";

type JsonRecord = Record<string, unknown>;

const HOOK: string = "/usr/local/bin/murmur-hook";
const PROXY: string = "/usr/local/bin/murmur-e2ee-proxy";
const LOCAL_URL: string = "http://localhost:4747/mcp";
// Oh My Pi expands this placeholder itself; the test asserts the literal reference, not a value.
const TOKEN_REFERENCE: string = ["$", "{MURMUR_API_TOKEN}"].join("");

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function murmurServer(configuration: JsonRecord): JsonRecord {
  return requireRecord(requireRecord(configuration["mcpServers"])["murmur"]);
}

function paths(directory: string): UserConfigurationPaths {
  return {
    claudeMcp: join(directory, ".claude.json"),
    claudeSettings: join(directory, ".claude", "settings.json"),
    codexConfig: join(directory, ".codex", "config.toml"),
    codexHooks: join(directory, ".codex", "hooks.json"),
    cursorMcp: join(directory, ".cursor", "mcp.json"),
    fxInstructions: join(directory, ".fx", "AGENTS.md"),
    fxMcp: join(directory, ".fx", "mcp.json"),
    ompExtension: join(directory, ".omp", "agent", "extensions", "murmur.ts"),
    ompMcp: join(directory, ".omp", "agent", "mcp.json"),
    opencodeConfig: join(directory, ".config", "opencode", "opencode.json"),
    piMcp: join(directory, ".config", "mcp", "mcp.json"),
  };
}

test("writes a native Oh My Pi HTTP entry with an environment token reference", (): void => {
  const configured: JsonRecord = configureOmpMcp(
    {
      $schema: "https://example.test/mcp-schema.json",
      disabledServers: ["noisy"],
      mcpServers: { other: { command: "other" } },
    },
    DEFAULT_MURMUR_URL,
  );
  expect(configured["$schema"]).toBe("https://example.test/mcp-schema.json");
  expect(configured["disabledServers"]).toEqual(["noisy"]);
  expect(requireRecord(configured["mcpServers"])["other"]).toEqual({ command: "other" });
  expect(murmurServer(configured)).toEqual({
    headers: { Authorization: `Bearer ${TOKEN_REFERENCE}`, "X-Murmur-Client": "omp" },
    type: "http",
    url: DEFAULT_MURMUR_URL,
  });
  expect(configureOmpMcp(configured, DEFAULT_MURMUR_URL)).toEqual(configured);
});

test("preserves unrelated headers, upgrades bootstrap entries, and guards conflicts", (): void => {
  const upgraded: JsonRecord = configureOmpMcp(
    {
      mcpServers: {
        murmur: {
          headers: { "X-Custom": "keep", "x-murmur-client": "stale" },
          type: "http",
          url: DEFAULT_MURMUR_URL,
        },
      },
    },
    DEFAULT_MURMUR_URL,
  );
  expect(murmurServer(upgraded)["headers"]).toEqual({
    Authorization: `Bearer ${TOKEN_REFERENCE}`,
    "X-Custom": "keep",
    "X-Murmur-Client": "omp",
  });
  const bootstrap: JsonRecord = configureOmpMcp(
    { mcpServers: { murmur: { type: "http", url: "https://api.usemurmur.dev/setup/mcp" } } },
    DEFAULT_MURMUR_URL,
  );
  expect(murmurServer(bootstrap)["url"]).toBe(DEFAULT_MURMUR_URL);
  const conflicting: JsonRecord = {
    mcpServers: { murmur: { type: "http", url: "https://different.example/mcp" } },
  };
  expect((): JsonRecord => configureOmpMcp(conflicting, DEFAULT_MURMUR_URL)).toThrow(
    "Oh My Pi already has a different Murmur MCP configuration",
  );
  expect(murmurServer(configureOmpMcp(conflicting, DEFAULT_MURMUR_URL, true))["url"]).toBe(
    DEFAULT_MURMUR_URL,
  );
  const stdioConflict: JsonRecord = { mcpServers: { murmur: { command: "other-proxy" } } };
  expect((): JsonRecord => configureOmpMcp(stdioConflict, DEFAULT_MURMUR_URL)).toThrow("--replace");
});

test("configures the local E2E proxy as a stdio entry that names the token variable", (): void => {
  const configured: JsonRecord = configureOmpE2eeMcp(
    {},
    DEFAULT_MURMUR_URL,
    PROXY,
    false,
    "/v/e.db",
  );
  expect(murmurServer(configured)).toEqual({
    args: ["--url", DEFAULT_MURMUR_URL, "--client", "omp", "--vault-path", "/v/e.db"],
    command: PROXY,
    env: { MURMUR_API_TOKEN: TOKEN_REFERENCE },
    type: "stdio",
  });
  expect(configureOmpE2eeMcp(configured, DEFAULT_MURMUR_URL, PROXY, false, "/v/e.db")).toEqual(
    configured,
  );
  expect(
    (): JsonRecord =>
      configureOmpE2eeMcp(configured, DEFAULT_MURMUR_URL, "/other/proxy", false, "/v/e.db"),
  ).toThrow("--replace");
  const replaced: JsonRecord = configureOmpE2eeMcp(
    configured,
    DEFAULT_MURMUR_URL,
    "/other/proxy",
    true,
  );
  expect(murmurServer(replaced)["command"]).toBe("/other/proxy");
  expect(murmurServer(configureOmpMcp(configured, DEFAULT_MURMUR_URL, true))["type"]).toBe("http");
});

test("generates a self-contained managed extension that drives murmur-hook", (): void => {
  const source: string = ompExtensionSource({
    e2ee: true,
    hookExecutable: "/it's here/murmur-hook",
    url: LOCAL_URL,
    vaultPath: "/vault/e2ee.sqlite",
  });
  expect(source.startsWith(`${OMP_EXTENSION_MARKER}\n`)).toBe(true);
  expect(source).toContain(
    `const HOOK_COMMAND: readonly string[] = ${JSON.stringify([
      "/it's here/murmur-hook",
      "--client",
      "omp",
      "--e2ee",
      "--vault-path",
      "/vault/e2ee.sqlite",
    ])};`,
  );
  expect(source).toContain(`const MURMUR_URL: string = ${JSON.stringify(LOCAL_URL)};`);
  expect(source).not.toContain("import ");
  for (const event of [
    "session_start",
    "before_agent_start",
    "tool_result",
    "agent_end",
    "session_shutdown",
    "mcp_notification",
  ]) {
    expect(source).toContain(`pi.on("${event}"`);
  }
  for (const hookEvent of [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ]) {
    expect(source).toContain(`runHook("${hookEvent}"`);
  }
  expect(source).toContain("export default function murmur(");
  expect(ompHookCommand({ e2ee: false, hookExecutable: HOOK, url: LOCAL_URL })).toEqual([
    HOOK,
    "--client",
    "omp",
  ]);
});

test("the generated extension transpiles and registers every lifecycle handler", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-omp-extension-"));
  const path: string = join(directory, "murmur.ts");
  try {
    writeFileSync(path, ompExtensionSource({ e2ee: false, hookExecutable: HOOK, url: LOCAL_URL }));
    const module: unknown = await import(path);
    if (!isRecord(module) || typeof module["default"] !== "function") {
      throw new Error("The extension must default-export a factory");
    }
    const registered: string[] = [];
    module["default"]({
      on: (event: string): void => {
        registered.push(event);
      },
      sendMessage: (): void => {
        throw new Error("sendMessage must not run during registration");
      },
    });
    expect(registered).toEqual([
      "session_start",
      "before_agent_start",
      "tool_result",
      "mcp_notification",
      "agent_end",
      "session_shutdown",
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("replaces only managed extensions and refuses unmanaged files without --replace", (): void => {
  const options: Parameters<typeof configureOmpExtension>[1] = {
    e2ee: false,
    hookExecutable: HOOK,
    url: LOCAL_URL,
  };
  const generated: string = configureOmpExtension("", options);
  expect(configureOmpExtension(generated, options)).toBe(generated);
  const stale: string = `${OMP_EXTENSION_MARKER}\n// older generated content\n`;
  expect(configureOmpExtension(stale, options)).toBe(generated);
  expect((): string => configureOmpExtension("export default () => {};\n", options)).toThrow(
    "unmanaged extensions/murmur.ts",
  );
  expect(configureOmpExtension("export default () => {};\n", options, true)).toBe(generated);
});

test("installs Oh My Pi atomically, requires the hook executable, and stays idempotent", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-omp-install-"));
  const target: UserConfigurationPaths = paths(directory);
  try {
    mkdirSync(join(directory, ".omp", "agent"), { recursive: true });
    writeFileSync(target.ompMcp, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    expect((): readonly string[] =>
      installUserConfiguration({ clients: ["omp"], paths: target }),
    ).toThrow("requires the local hook executable");
    const changed: readonly string[] = installUserConfiguration({
      clients: ["omp"],
      hookExecutable: HOOK,
      paths: target,
      url: LOCAL_URL,
    });
    expect(changed).toEqual([target.ompMcp, target.ompExtension]);
    const mcp: JsonRecord = JSON.parse(readFileSync(target.ompMcp, "utf8"));
    expect(requireRecord(mcp["mcpServers"])["other"]).toEqual({ command: "other" });
    expect(murmurServer(mcp)["url"]).toBe(LOCAL_URL);
    expect(readFileSync(target.ompExtension, "utf8")).toContain(JSON.stringify(LOCAL_URL));
    expect(
      installUserConfiguration({
        clients: ["omp"],
        hookExecutable: HOOK,
        paths: target,
        url: LOCAL_URL,
      }),
    ).toEqual([]);
    expect(existsSync(target.claudeMcp)).toBe(false);

    const e2ee: readonly string[] = installUserConfiguration({
      clients: ["omp"],
      e2ee: true,
      e2eeProxyExecutable: PROXY,
      hookExecutable: HOOK,
      paths: target,
      replace: true,
      url: LOCAL_URL,
    });
    expect(e2ee).toEqual([target.ompMcp, target.ompExtension]);
    expect(murmurServer(JSON.parse(readFileSync(target.ompMcp, "utf8")))["command"]).toBe(PROXY);
    expect(readFileSync(target.ompExtension, "utf8")).toContain('"--e2ee"');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("resolves the Oh My Pi agent directory from the explicit directory, profile, or home", (): void => {
  const explicit: UserConfigurationPaths = defaultUserConfigurationPaths(
    { HOME: "/users/test", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/opt/omp-agent" },
    "linux",
  );
  expect(explicit.ompMcp).toBe("/opt/omp-agent/mcp.json");
  expect(explicit.ompExtension).toBe("/opt/omp-agent/extensions/murmur.ts");
  const profile: UserConfigurationPaths = defaultUserConfigurationPaths(
    { HOME: "/users/test", PI_PROFILE: "lab" },
    "linux",
  );
  expect(profile.ompMcp).toBe("/users/test/.omp/profiles/lab/agent/mcp.json");
  const preferred: UserConfigurationPaths = defaultUserConfigurationPaths(
    { HOME: "/users/test", OMP_PROFILE: "work", PI_PROFILE: "lab" },
    "linux",
  );
  expect(preferred.ompMcp).toBe("/users/test/.omp/profiles/work/agent/mcp.json");
  const windows: UserConfigurationPaths = defaultUserConfigurationPaths(
    { PI_CODING_AGENT_DIR: " ", USERPROFILE: "C:\\Users\\test" },
    "win32",
  );
  expect(windows.ompExtension).toBe("C:\\Users\\test\\.omp\\agent\\extensions\\murmur.ts");
});
