import { expect, test } from "bun:test";
import { isBootstrapMurmurEndpoint } from "../src/setup/bootstrap-configuration.js";
import {
  configureClaudeE2eeMcp,
  configureCodexE2eeMcp,
} from "../src/setup/e2ee-client-configuration.js";
import { configureClaudeMcp, configureCodexMcp } from "../src/setup/user-configuration.js";

const TARGET: string = "https://api.usemurmur.dev/mcp";
const BOOTSTRAP: string = "https://api.usemurmur.dev/setup/mcp";
const CODEX: string = `[mcp_servers.unrelated]\ncommand = "another-tool"\n\n[mcp_servers.murmur]\nurl = "${BOOTSTRAP}"\n`;
const CLAUDE: Record<string, unknown> = {
  mcpServers: {
    unrelated: { command: "another-tool" },
    murmur: { type: "http", url: BOOTSTRAP },
  },
};

test("anonymous same-origin MCP setup upgrades to authenticated MCP without a conflicting-name prompt", (): void => {
  const codex: string = configureCodexMcp(CODEX, TARGET);
  expect(codex).toContain(`url = "${TARGET}"`);
  expect(codex).toContain('bearer_token_env_var = "MURMUR_API_TOKEN"');
  expect(codex).toContain("another-tool");
  expect(codex).not.toContain("/setup/mcp");
  expect(configureCodexMcp(codex, TARGET)).toBe(codex);
  const claude: Record<string, unknown> = configureClaudeMcp(CLAUDE, TARGET);
  expect(claude).toMatchObject({
    mcpServers: {
      unrelated: { command: "another-tool" },
      murmur: {
        type: "http",
        url: TARGET,
        headers: { Authorization: `Bearer \${MURMUR_API_TOKEN}` },
      },
    },
  });
  expect(configureClaudeMcp(claude, TARGET)).toEqual(claude);
});

test("anonymous setup can transition directly to the encrypted local proxy", (): void => {
  const codex: string = configureCodexE2eeMcp(CODEX, TARGET, "murmur-e2ee-proxy");
  expect(codex).toContain('command = "murmur-e2ee-proxy"');
  expect(codex).toContain("another-tool");
  expect(codex).not.toContain("/setup/mcp");
  expect(configureCodexE2eeMcp(codex, TARGET, "murmur-e2ee-proxy")).toBe(codex);
  const claude: Record<string, unknown> = configureClaudeE2eeMcp(
    CLAUDE,
    TARGET,
    "murmur-e2ee-proxy",
  );
  expect(claude).toMatchObject({
    mcpServers: {
      murmur: { type: "stdio", command: "murmur-e2ee-proxy" },
      unrelated: { command: "another-tool" },
    },
  });
});

test("bootstrap migration never authorizes arbitrary endpoint, origin, protocol, or parameter replacement", (): void => {
  const invalid: unknown[] = [
    undefined,
    "invalid",
    "https://different.example/setup/mcp",
    "https://api.usemurmur.dev/other",
    `${BOOTSTRAP}?token=hidden`,
    `${BOOTSTRAP}#fragment`,
    // biome-ignore lint/security/noSecrets: This synthetic URL verifies that embedded credentials are rejected.
    "https://user:password@api.usemurmur.dev/setup/mcp",
  ];
  for (const value of invalid) expect(isBootstrapMurmurEndpoint(value, TARGET)).toBe(false);
  expect(isBootstrapMurmurEndpoint(BOOTSTRAP, `${TARGET}?hidden=1`)).toBe(false);
  expect(isBootstrapMurmurEndpoint(BOOTSTRAP, "invalid")).toBe(false);
  expect(isBootstrapMurmurEndpoint("ftp://localhost/setup/mcp", "ftp://localhost/mcp")).toBe(false);
  expect(isBootstrapMurmurEndpoint("http://localhost/setup/mcp", "http://localhost/mcp")).toBe(
    true,
  );
  const conflict: string = CODEX.replace(BOOTSTRAP, "https://different.example/setup/mcp");
  expect((): string => configureCodexMcp(conflict, TARGET)).toThrow("--replace");
  expect((): string => configureCodexE2eeMcp(conflict, TARGET, "murmur-e2ee-proxy")).toThrow(
    "--replace",
  );
  const other: Record<string, unknown> = {
    mcpServers: { murmur: { type: "http", url: "https://different.example/setup/mcp" } },
  };
  expect((): Record<string, unknown> => configureClaudeMcp(other, TARGET)).toThrow("--replace");
  expect(
    (): Record<string, unknown> => configureClaudeE2eeMcp(other, TARGET, "murmur-e2ee-proxy"),
  ).toThrow("--replace");
});
