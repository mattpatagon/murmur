import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CliResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

const cliPath: string = resolve("src/cli.ts");
const hookPath: string = resolve("src/hook.ts");

function runCli(arguments_: readonly string[], environment: NodeJS.ProcessEnv = {}): CliResult {
  const result: Bun.ReadableSyncSubprocess = Bun.spawnSync(
    [process.execPath, cliPath, ...arguments_],
    {
      env: { ...process.env, ...environment },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

test("prints setup help without changing user configuration", (): void => {
  const result: CliResult = runCli([]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("murmur setup --user");
  expect(result.stderr).toBe("");
});

test("rejects invalid setup arguments and insecure remote URLs", (): void => {
  expect(runCli(["setup", "--codex"]).stderr).toContain("Rerun with --user");
  expect(runCli(["setup", "--user", "--url"]).stderr).toContain("--url requires a value");
  expect(runCli(["setup", "--user", "--unknown"]).stderr).toContain("Unknown setup option");
  expect(
    runCli([
      "setup",
      "--user",
      "--vault-path",
      "/tmp/murmur-vault.sqlite",
      "--hook-executable",
      hookPath,
    ]).stderr,
  ).toContain("--vault-path requires --e2ee and an absolute path");
  expect(
    runCli([
      "setup",
      "--user",
      "--e2ee",
      "--vault-path",
      "relative-vault.sqlite",
      "--hook-executable",
      hookPath,
    ]).stderr,
  ).toContain("--vault-path requires --e2ee and an absolute path");
  expect(
    runCli(["setup", "--user", "--url", "http://remote.example/mcp", "--hook-executable", hookPath])
      .stderr,
  ).toContain("must use HTTPS");
});

test("configures all supported clients at user scope without copying the API token", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-cli-"));
  try {
    const result: CliResult = runCli(["setup", "--user", "--hook-executable", hookPath], {
      CLAUDE_CONFIG_DIR: join(directory, "claude"),
      CODEX_HOME: join(directory, "codex"),
      HOME: directory,
      MURMUR_API_TOKEN: "must-not-be-written",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Configured Murmur user-level MCP");
    expect(result.stdout).toContain("no token was written");
    const combined: string = [
      readFileSync(join(directory, "claude", ".claude.json"), "utf8"),
      readFileSync(join(directory, "claude", "settings.json"), "utf8"),
      readFileSync(join(directory, "codex", "config.toml"), "utf8"),
      readFileSync(join(directory, "codex", "hooks.json"), "utf8"),
      readFileSync(join(directory, ".fx", "AGENTS.md"), "utf8"),
      readFileSync(join(directory, ".fx", "mcp.json"), "utf8"),
      readFileSync(join(directory, ".config", "opencode", "opencode.json"), "utf8"),
      readFileSync(join(directory, ".cursor", "mcp.json"), "utf8"),
      readFileSync(join(directory, ".config", "mcp", "mcp.json"), "utf8"),
    ].join("\n");
    expect(combined).toContain("MURMUR_API_TOKEN");
    expect(combined).toContain('client: "fx"');
    expect(combined).not.toContain("must-not-be-written");
    expect(result.stdout).toContain("pi-mcp-adapter");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("selects one client and reports an idempotent second setup", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-cli-one-client-"));
  const installedHookPath: string = join(directory, "murmur-hook");
  const environment: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    CODEX_HOME: join(directory, "codex"),
    HOME: directory,
    MURMUR_API_TOKEN: "",
  };
  const arguments_: readonly string[] = [
    "setup",
    "--user",
    "--codex",
    "--codex",
    "--url",
    "http://localhost:4321/mcp",
    "--hook-executable",
    installedHookPath,
  ];
  try {
    writeFileSync(installedHookPath, "#!/usr/bin/env bun\n");
    expect(runCli(arguments_, environment).stdout).toContain("MURMUR_API_TOKEN is not set");
    const second: CliResult = runCli(arguments_, environment);
    expect(second.stdout).toContain("already configured");
    expect(readFileSync(join(directory, "codex", "config.toml"), "utf8")).toContain(
      "http://localhost:4321/mcp",
    );
    expect(existsSync(join(directory, ".claude.json"))).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("selects each hook-free client without requiring a hook executable", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-cli-native-clients-"));
  const environment: NodeJS.ProcessEnv = { HOME: directory, MURMUR_API_TOKEN: "" };
  try {
    const opencode: CliResult = runCli(["setup", "--user", "--opencode"], environment);
    expect(opencode.exitCode).toBe(0);
    expect(opencode.stdout).not.toContain("pi-mcp-adapter");
    expect(existsSync(join(directory, ".config", "opencode", "opencode.json"))).toBe(true);

    const cursor: CliResult = runCli(["setup", "--user", "--cursor"], environment);
    expect(cursor.exitCode).toBe(0);
    expect(existsSync(join(directory, ".cursor", "mcp.json"))).toBe(true);

    const fx: CliResult = runCli(["setup", "--user", "--fx"], environment);
    expect(fx.exitCode).toBe(0);
    expect(existsSync(join(directory, ".fx", "mcp.json"))).toBe(true);
    expect(existsSync(join(directory, ".fx", "AGENTS.md"))).toBe(true);

    const pi: CliResult = runCli(["setup", "--user", "--pi"], environment);
    expect(pi.exitCode).toBe(0);
    expect(pi.stdout).toContain("pi-mcp-adapter");
    expect(existsSync(join(directory, ".config", "mcp", "mcp.json"))).toBe(true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("configures E2E clients through a local proxy without copying the token", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-cli-e2ee-"));
  const proxyPath: string = join(directory, "murmur-e2ee-proxy");
  const vaultPath: string = join(directory, "custom vault", "vault.sqlite");
  try {
    writeFileSync(proxyPath, "#!/usr/bin/env bun\n");
    const result: CliResult = runCli(
      [
        "setup",
        "--user",
        "--e2ee",
        "--replace",
        "--hook-executable",
        hookPath,
        "--proxy-executable",
        proxyPath,
        "--vault-path",
        vaultPath,
      ],
      {
        CLAUDE_CONFIG_DIR: join(directory, "claude"),
        CODEX_HOME: join(directory, "codex"),
        HOME: directory,
        MURMUR_API_TOKEN: "must-not-be-written",
      },
    );
    expect(result.exitCode).toBe(0);
    const combined: string = [
      readFileSync(join(directory, "claude", ".claude.json"), "utf8"),
      readFileSync(join(directory, "claude", "settings.json"), "utf8"),
      readFileSync(join(directory, "codex", "config.toml"), "utf8"),
      readFileSync(join(directory, "codex", "hooks.json"), "utf8"),
      readFileSync(join(directory, ".fx", "AGENTS.md"), "utf8"),
      readFileSync(join(directory, ".fx", "mcp.json"), "utf8"),
      readFileSync(join(directory, ".config", "opencode", "opencode.json"), "utf8"),
      readFileSync(join(directory, ".cursor", "mcp.json"), "utf8"),
      readFileSync(join(directory, ".config", "mcp", "mcp.json"), "utf8"),
    ].join("\n");
    expect(combined).toContain(proxyPath);
    expect(combined).toContain("--e2ee");
    expect(combined.match(/custom vault/gu)).toHaveLength(16);
    expect(combined).not.toContain("must-not-be-written");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
