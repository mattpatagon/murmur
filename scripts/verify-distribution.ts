import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import { buildDistribution } from "./build-distribution.js";

function requireCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  input?: string | undefined,
): string {
  return execFileSync(process.execPath, [...arguments_], {
    cwd,
    encoding: "utf8",
    env: environment,
    input,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
}

async function verifyMcp(
  executable: string,
  directory: string,
  environment: Record<string, string>,
): Promise<void> {
  const client: Client = new Client({ name: "murmur-package-smoke", version: "1.0.0" });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: [executable],
    command: process.execPath,
    cwd: directory,
    env: environment,
    stderr: "pipe",
  });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools: ListToolsResult = await client.listTools({}, { timeout: 10_000 });
    requireCondition(
      tools.tools.some(
        (tool: ListToolsResult["tools"][number]): boolean => tool.name === "get_setup_guide",
      ),
      "Installed MCP does not expose its setup guide",
    );
    const guide: CallToolResult = CallToolResultSchema.parse(
      await client.callTool({ name: "get_setup_guide", arguments: {} }, CallToolResultSchema, {
        timeout: 10_000,
      }),
    );
    requireCondition(guide.isError !== true, "Installed MCP could not return its setup guide");
    const registration: CallToolResult = CallToolResultSchema.parse(
      await client.callTool(
        { name: "register_agent", arguments: { agent_id: "package-smoke" } },
        CallToolResultSchema,
        { timeout: 10_000 },
      ),
    );
    requireCondition(
      registration.isError !== true,
      "Installed MCP could not register a local SQLite agent",
    );
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-distribution-"));
  try {
    const artifactDirectory: string = join(directory, "artifact");
    await buildDistribution(artifactDirectory, "1111111111111111111111111111111111111111");
    const archive: Bun.Archive = new Bun.Archive(
      readFileSync(join(artifactDirectory, "murmur.tgz")),
    );
    const entries: Map<string, File> = await archive.files();
    const paths: string[] = [...entries.keys()].sort();
    requireCondition(
      paths.length === 8 &&
        paths.every((path: string): boolean =>
          /^package\/(?:bin\/(?:cli|hook|server|e2ee-proxy)\.js|LICENSE|README\.md|THIRD_PARTY_NOTICES\.txt|package\.json)$/u.test(
            path,
          ),
        ),
      "Public package contains unexpected files",
    );
    const globalDirectory: string = join(directory, "bun", "install", "global");
    const binaryDirectory: string = join(directory, "bun", "bin");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      BUN_INSTALL: join(directory, "bun"),
      CLAUDE_CONFIG_DIR: join(directory, "claude"),
      CODEX_HOME: join(directory, "codex"),
      MURMUR_API_TOKEN: "",
      MURMUR_DATABASE_URL: "",
      MURMUR_DB_PATH: join(directory, "messages.db"),
      MURMUR_E2EE_VAULT_PATH: join(directory, "vault.sqlite"),
      PATH: [binaryDirectory, dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter),
    };
    run(["install", "--global", join(artifactDirectory, "murmur.tgz")], directory, environment);
    const installed: string = join(globalDirectory, "node_modules", "murmur-agent-chat-mcp", "bin");
    const cli: string = join(installed, "cli.js");
    requireCondition(
      run([cli, "--help"], directory, environment).includes("murmur setup"),
      "Installed CLI help failed",
    );
    mkdirSync(join(directory, "codex"), { recursive: true });
    mkdirSync(join(directory, "claude"), { recursive: true });
    writeFileSync(
      join(directory, "codex", "config.toml"),
      '[mcp_servers.murmur]\nurl = "https://api.usemurmur.dev/setup/mcp"\n',
    );
    writeFileSync(
      join(directory, "claude", ".claude.json"),
      JSON.stringify({
        mcpServers: { murmur: { type: "http", url: "https://api.usemurmur.dev/setup/mcp" } },
      }),
    );
    run([cli, "setup", "--user"], directory, environment);
    requireCondition(
      readFileSync(join(directory, "codex", "hooks.json"), "utf8").includes("murmur-hook"),
      "Installed setup omitted hooks",
    );
    run([cli, "setup", "--user", "--e2ee", "--replace"], directory, environment);
    requireCondition(
      readFileSync(join(directory, "codex", "config.toml"), "utf8").includes("murmur-e2ee-proxy"),
      "Installed setup omitted encryption proxy",
    );
    const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"));
    try {
      const now: Date = new Date();
      await vault.keys.getOrCreateAgent(
        "package-smoke",
        now.toISOString(),
        new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    } finally {
      vault.close();
    }
    requireCondition(
      run(
        [
          cli,
          "e2ee",
          "rotate-agent-key",
          "--agent",
          "package-smoke",
          "--vault-path",
          join(directory, "vault.sqlite"),
        ],
        directory,
        environment,
      ).includes('"agent_id": "package-smoke"'),
      "Installed crypto key rotation failed",
    );
    requireCondition(
      run(
        [cli, "e2ee", "fingerprint", "--vault-path", join(directory, "vault.sqlite")],
        directory,
        environment,
      )
        .trim()
        .startsWith("mrk_"),
      "Installed cryptography bundle failed",
    );
    run(
      [join(installed, "hook.js"), "--client", "codex"],
      directory,
      environment,
      JSON.stringify({ hook_event_name: "Stop", cwd: directory, session_id: "package-smoke" }),
    );
    // Importing the proxy checks its complete bundled dependency graph without making a hosted request.
    run(
      ["-e", "await import(process.argv[1])", resolve(installed, "e2ee-proxy.js")],
      directory,
      environment,
    );
    const mcpEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined) mcpEnvironment[name] = value;
    }
    await verifyMcp(join(installed, "server.js"), directory, mcpEnvironment);
    process.stdout.write(
      "Public package installed without repository access; setup, hooks, local MCP guide, SQLite, and E2E crypto passed.\n",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (import.meta.main) await main();
