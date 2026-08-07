import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  configureClaudeMcp,
  configureCodexMcp,
  configureHooks,
  DEFAULT_MURMUR_URL,
  installUserConfiguration,
  type UserConfigurationPaths,
} from "../src/setup/user-configuration.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}

test("adds the Codex MCP table without disturbing existing TOML", (): void => {
  const current: string = 'model = "gpt-5"\n';
  const configured: string = configureCodexMcp(current, DEFAULT_MURMUR_URL);
  expect(configured).toContain('model = "gpt-5"');
  expect(configured).toContain("[mcp_servers.murmur]");
  expect(configured).toContain(`url = "${DEFAULT_MURMUR_URL}"`);
  expect(configured).toContain('bearer_token_env_var = "MURMUR_API_TOKEN"');
  expect(configured).toContain('"X-Murmur-Client" = "codex"');
});

test("upgrades an existing Codex entry with the client header idempotently", (): void => {
  const current: string = `[mcp_servers.murmur]
url = "${DEFAULT_MURMUR_URL}"
bearer_token_env_var = "MURMUR_API_TOKEN"

[projects."/workspace"]
trust_level = "trusted"
`;
  const once: string = configureCodexMcp(current, DEFAULT_MURMUR_URL);
  const twice: string = configureCodexMcp(once, DEFAULT_MURMUR_URL);
  expect(once).toBe(twice);
  const clientHeaders: RegExpMatchArray | null = once.match(/X-Murmur-Client/gu);
  expect(clientHeaders === null ? 0 : clientHeaders.length).toBe(1);
  expect(once).toContain('[projects."/workspace"]');
});

test("removes static repository and branch headers from user-level Codex", (): void => {
  const current: string = `[mcp_servers.murmur]
url = "${DEFAULT_MURMUR_URL}"
bearer_token_env_var = "MURMUR_API_TOKEN"
http_headers = { "X-Murmur-Repository" = "owner/old", "X-Other" = "kept", "X-Murmur-Branch" = "old", "X-Murmur-Client" = "codex" }
`;
  const configured: string = configureCodexMcp(current, DEFAULT_MURMUR_URL);
  expect(configured).not.toContain("X-Murmur-Repository");
  expect(configured).not.toContain("X-Murmur-Branch");
  expect(configured).toContain('"X-Other" = "kept"');
  expect(configured).toContain('"X-Murmur-Client" = "codex"');
});

test("requires explicit replacement for a conflicting Codex entry", (): void => {
  const current: string = `[mcp_servers.murmur]
url = "https://wrong.example/mcp"
bearer_token_env_var = "OLD_TOKEN"
`;
  expect((): string => configureCodexMcp(current, DEFAULT_MURMUR_URL)).toThrow("--replace");
  const replaced: string = configureCodexMcp(current, DEFAULT_MURMUR_URL, true);
  expect(replaced).not.toContain("wrong.example");
  expect(replaced).toContain(DEFAULT_MURMUR_URL);
});

test("does not create a duplicate Codex client header", (): void => {
  const current: string = `[mcp_servers.murmur]
url = "${DEFAULT_MURMUR_URL}"
bearer_token_env_var = "MURMUR_API_TOKEN"
http_headers = { "X-Murmur-Client" = "other" }
`;
  expect((): string => configureCodexMcp(current, DEFAULT_MURMUR_URL)).toThrow("--replace");
  const replaced: string = configureCodexMcp(current, DEFAULT_MURMUR_URL, true);
  const clientHeaders: RegExpMatchArray | null = replaced.match(/X-Murmur-Client/gu);
  expect(clientHeaders === null ? 0 : clientHeaders.length).toBe(1);
  expect(replaced).toContain('"X-Murmur-Client" = "codex"');
});

test("configures Claude without embedding a token or dropping unrelated settings", (): void => {
  const configured: Record<string, unknown> = configureClaudeMcp(
    {
      mcpServers: {
        another: { command: "another-server" },
        murmur: {
          type: "http",
          url: DEFAULT_MURMUR_URL,
          headers: {
            "X-Existing": "kept",
            "X-Murmur-Branch": "old",
            "X-Murmur-Repository": "owner/old",
          },
        },
      },
      theme: "dark",
    },
    DEFAULT_MURMUR_URL,
  );
  expect(configured["theme"]).toBe("dark");
  const servers: Record<string, unknown> = requireRecord(configured["mcpServers"]);
  expect(servers["another"]).toEqual({ command: "another-server" });
  const murmur: Record<string, unknown> = requireRecord(servers["murmur"]);
  expect(murmur["headers"]).toEqual({
    Authorization: `Bearer \${MURMUR_API_TOKEN}`,
    "X-Existing": "kept",
    "X-Murmur-Client": "claude",
  });
});

test("merges one owned hook per event and preserves other hooks", (): void => {
  const otherGroup: Record<string, unknown> = {
    matcher: "Bash",
    hooks: [{ type: "command", command: "existing-hook" }],
  };
  const once: Record<string, unknown> = configureHooks(
    { hooks: { PostToolUse: [otherGroup] }, permissions: { allow: ["Read"] } },
    "claude",
    "/opt/murmur hook/murmur-hook",
  );
  const twice: Record<string, unknown> = configureHooks(
    once,
    "claude",
    "/opt/murmur hook/murmur-hook",
  );
  expect(twice).toEqual(once);
  expect(once["permissions"]).toEqual({ allow: ["Read"] });
  const events: Record<string, unknown> = requireRecord(once["hooks"]);
  const postToolUse: unknown[] = requireArray(events["PostToolUse"]);
  expect(postToolUse[0]).toEqual(otherGroup);
  expect(JSON.stringify(events["SessionStart"])).toContain(
    "'/opt/murmur hook/murmur-hook' --client claude",
  );
});

test("installs both clients atomically and a second run changes nothing", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-setup-"));
  const paths: UserConfigurationPaths = {
    claudeMcp: join(directory, ".claude.json"),
    claudeSettings: join(directory, ".claude", "settings.json"),
    codexConfig: join(directory, ".codex", "config.toml"),
    codexHooks: join(directory, ".codex", "hooks.json"),
  };
  try {
    writeFileSync(paths.claudeMcp, '{"theme":"dark"}\n');
    const first: readonly string[] = installUserConfiguration({
      clients: ["codex", "claude"],
      hookExecutable: "/usr/local/bin/murmur-hook",
      paths,
    });
    expect(first).toHaveLength(4);
    expect(readFileSync(paths.codexConfig, "utf8")).toContain("MURMUR_API_TOKEN");
    expect(readFileSync(paths.claudeMcp, "utf8")).toContain(`\${MURMUR_API_TOKEN}`);
    const second: readonly string[] = installUserConfiguration({
      clients: ["codex", "claude"],
      hookExecutable: "/usr/local/bin/murmur-hook",
      paths,
    });
    expect(second).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
