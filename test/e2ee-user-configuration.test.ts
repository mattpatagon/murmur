import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureClaudeE2eeMcp,
  configureCodexE2eeMcp,
} from "../src/setup/e2ee-client-configuration.js";
import {
  DEFAULT_MURMUR_URL,
  installUserConfiguration,
  type UserConfigurationPaths,
} from "../src/setup/user-configuration.js";

const PROXY: string = "/usr/local/bin/murmur-e2ee-proxy";
const CUSTOM_VAULT: string = "/var/lib/murmur agent/vault.sqlite";

test("configures an idempotent local Codex proxy without embedding credentials", (): void => {
  const current: string = 'model = "gpt-5"\n';
  const configured: string = configureCodexE2eeMcp(current, DEFAULT_MURMUR_URL, PROXY);
  expect(configured).toContain('model = "gpt-5"');
  expect(configured).toContain(`command = ${JSON.stringify(PROXY)}`);
  expect(configured).toContain(
    `args = ${JSON.stringify(["--url", DEFAULT_MURMUR_URL, "--client", "codex"])}`,
  );
  expect(configured).not.toContain("bearer_token_env_var");
  expect(configureCodexE2eeMcp(configured, DEFAULT_MURMUR_URL, PROXY)).toBe(configured);
});

test("requires explicit replacement before changing a remote Codex entry", (): void => {
  const current: string = `[mcp_servers.murmur]\nurl = ${JSON.stringify(DEFAULT_MURMUR_URL)}\nbearer_token_env_var = "MURMUR_API_TOKEN"\n\n[mcp_servers.other]\ncommand = "other"\n`;
  expect((): string => configureCodexE2eeMcp(current, DEFAULT_MURMUR_URL, PROXY)).toThrow(
    "--replace",
  );
  const replaced: string = configureCodexE2eeMcp(current, DEFAULT_MURMUR_URL, PROXY, true);
  expect(replaced).toContain("[mcp_servers.other]");
  expect(replaced).not.toContain("bearer_token_env_var");
  expect(replaced.match(/\[mcp_servers\.murmur\]/gu)).toHaveLength(1);
});

test("configures an idempotent local Claude proxy and preserves unrelated settings", (): void => {
  const current: Record<string, unknown> = {
    mcpServers: { another: { command: "other" } },
    theme: "dark",
  };
  const configured: Record<string, unknown> = configureClaudeE2eeMcp(
    current,
    DEFAULT_MURMUR_URL,
    PROXY,
  );
  expect(configured["theme"]).toBe("dark");
  expect(configured).toMatchObject({
    mcpServers: {
      another: { command: "other" },
      murmur: {
        args: ["--url", DEFAULT_MURMUR_URL, "--client", "claude"],
        command: PROXY,
        type: "stdio",
      },
    },
  });
  expect(JSON.stringify(configured)).not.toContain("Authorization");
  expect(configureClaudeE2eeMcp(configured, DEFAULT_MURMUR_URL, PROXY)).toBe(configured);
});

test("installs proxy clients and content-free hooks atomically", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-setup-"));
  const paths: UserConfigurationPaths = {
    claudeMcp: join(directory, ".claude.json"),
    claudeSettings: join(directory, ".claude", "settings.json"),
    codexConfig: join(directory, ".codex", "config.toml"),
    codexHooks: join(directory, ".codex", "hooks.json"),
    cursorMcp: join(directory, ".cursor", "mcp.json"),
    opencodeConfig: join(directory, ".config", "opencode", "opencode.json"),
    piMcp: join(directory, ".config", "mcp", "mcp.json"),
  };
  try {
    writeFileSync(paths.claudeMcp, '{"theme":"dark"}\n');
    const changed: readonly string[] = installUserConfiguration({
      clients: ["codex", "claude"],
      e2ee: true,
      e2eeProxyExecutable: PROXY,
      e2eeVaultPath: CUSTOM_VAULT,
      hookExecutable: "/usr/local/bin/murmur-hook",
      paths,
      url: DEFAULT_MURMUR_URL,
    });
    expect(changed).toHaveLength(4);
    const installed: string = [
      readFileSync(paths.codexConfig, "utf8"),
      readFileSync(paths.codexHooks, "utf8"),
      readFileSync(paths.claudeMcp, "utf8"),
      readFileSync(paths.claudeSettings, "utf8"),
    ].join("\n");
    expect(installed).toContain("murmur-e2ee-proxy");
    expect(installed).toContain("--e2ee");
    expect(installed.match(/murmur agent\/vault\.sqlite/gu)).toHaveLength(12);
    expect(installed).not.toContain("Bearer ");
    expect(
      installUserConfiguration({
        clients: ["codex", "claude"],
        e2ee: true,
        e2eeProxyExecutable: PROXY,
        e2eeVaultPath: CUSTOM_VAULT,
        hookExecutable: "/usr/local/bin/murmur-hook",
        paths,
        url: DEFAULT_MURMUR_URL,
      }),
    ).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("validates the E2E proxy dependency before writing any configuration", (): void => {
  expect((): readonly string[] =>
    installUserConfiguration({
      clients: ["codex"],
      e2ee: true,
      hookExecutable: "/usr/local/bin/murmur-hook",
    }),
  ).toThrow("requires the local proxy executable");

  expect((): readonly string[] =>
    installUserConfiguration({
      clients: ["codex"],
      e2ee: true,
      e2eeProxyExecutable: PROXY,
      e2eeVaultPath: "relative-vault.sqlite",
      hookExecutable: "/usr/local/bin/murmur-hook",
    }),
  ).toThrow("requires E2E setup and an absolute path");
});
