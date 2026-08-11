import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

import { formatSetupResult, runCli, runCliAsync, type SetupAction, setup } from "../src/cli.js";
import {
  type AgentClient,
  AgentId,
  type BranchName,
  type RepositoryName,
} from "../src/domain/value-objects.js";
import { main, type StdioServerHandle, type StdioServerRuntime } from "../src/server.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

class NoopTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  public async start(): Promise<void> {}

  public async send(_message: JSONRPCMessage): Promise<void> {}

  public async close(): Promise<void> {
    const handler: (() => void) | undefined = this.onclose;
    if (handler !== undefined) handler();
  }
}

test("CLI core handles help, dispatch, and user-facing results without writing settings", (): void => {
  const unchanged: SetupAction = (_arguments: readonly string[]): readonly string[] => [];
  const changed: SetupAction = (arguments_: readonly string[]): readonly string[] => {
    expect(arguments_).toEqual(["--user", "--codex"]);
    return ["/config/codex.toml", "/config/hooks.json"];
  };
  expect(runCli([])).toContain("Usage:");
  expect(runCli(["setup", "--help"])).toContain("Authentication:");
  expect(runCli(["setup", "--user"], unchanged, " ")).toContain("is not set");
  const result: string = runCli(["setup", "--user", "--codex"], changed, "configured-token");
  expect(result).toContain("/config/codex.toml");
  expect(result).toContain("no token was written");
  expect((): string => runCli(["unknown"], unchanged)).toThrow("Unknown command");
  expect(formatSetupResult([], true)).toContain("already configured");
});

test("CLI setup parsing fails before mutation for incomplete or unsafe input", (): void => {
  expect((): readonly string[] => setup([])).toThrow("--user");
  expect((): readonly string[] => setup(["--user", "--url"])).toThrow("requires a value");
  expect((): readonly string[] => setup(["--user", "--unknown"])).toThrow("Unknown setup option");
  expect((): readonly string[] => setup(["--user", "--url", "http://remote.example/mcp"])).toThrow(
    "must use HTTPS",
  );
  expect((): readonly string[] =>
    setup(["--user", "--hook-executable", "/definitely/missing/murmur-hook"]),
  ).toThrow("Hook executable not found");
  expect((): readonly string[] =>
    setup([
      "--user",
      "--e2ee",
      "--hook-executable",
      import.meta.path,
      "--proxy-executable",
      "/definitely/missing/murmur-e2ee-proxy",
    ]),
  ).toThrow("E2E proxy executable not found");
  expect((): readonly string[] =>
    setup([
      "--user",
      "--claude",
      "--replace",
      "--hook-executable",
      "/definitely/missing/murmur-hook",
    ]),
  ).toThrow("Hook executable not found");
});

test("async CLI dispatch exposes E2E help without opening a vault", async (): Promise<void> => {
  expect(await runCliAsync(["e2ee", "--help"])).toContain("Murmur local end-to-end encryption");
});

test("direct setup installs E2E configuration only inside the selected user directories", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-entrypoint-"));
  const originalClaude: string | undefined = process.env["CLAUDE_CONFIG_DIR"];
  const originalCodex: string | undefined = process.env["CODEX_HOME"];
  const originalHome: string | undefined = process.env["HOME"];
  try {
    process.env["CLAUDE_CONFIG_DIR"] = join(directory, "claude");
    process.env["CODEX_HOME"] = join(directory, "codex");
    process.env["HOME"] = directory;
    expect(
      setup([
        "--user",
        "--codex",
        "--e2ee",
        "--replace",
        "--hook-executable",
        import.meta.path,
        "--proxy-executable",
        import.meta.path,
      ]),
    ).toHaveLength(2);
  } finally {
    process.env["CLAUDE_CONFIG_DIR"] = originalClaude;
    process.env["CODEX_HOME"] = originalCodex;
    process.env["HOME"] = originalHome;
    rmSync(directory, { force: true, recursive: true });
  }
});

test("stdio entrypoint installs deterministic signal shutdown handlers", async (): Promise<void> => {
  const listeners: Map<NodeJS.Signals, () => void> = new Map<NodeJS.Signals, () => void>();
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
  const runtime: StdioServerRuntime = {
    createStore: async (): Promise<MessageStore> => store,
    createTransport: (): Transport => new NoopTransport(),
    detectBranchName: (): BranchName | null => null,
    detectClient: (): AgentClient | null => null,
    detectRepositoryName: (): RepositoryName | null => null,
    onSignal: (signal: NodeJS.Signals, listener: () => void): void => {
      listeners.set(signal, listener);
    },
  };
  const handle: StdioServerHandle = await main(runtime);
  expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  const interrupt: (() => void) | undefined = listeners.get("SIGINT");
  const terminate: (() => void) | undefined = listeners.get("SIGTERM");
  if (interrupt === undefined || terminate === undefined) {
    throw new Error("Stdio signal listeners were not installed");
  }
  interrupt();
  terminate();
  await handle.shutdown();
  await handle.shutdown();
  expect((): unknown => store.getAgent(AgentId.parse("closed-agent"))).toThrow(
    "The message store is closed",
  );
});
