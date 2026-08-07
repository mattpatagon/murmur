import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  buildHookOutput,
  checkRemoteInbox,
  deriveAgentIdentity,
  handleHook,
  type AgentIdentity,
  type HookOutput,
  type InboxSummary,
} from "../src/hook.js";
import { startHttpServer, type MurmurHttpServer } from "../src/http-server.js";

function requireOutput(output: HookOutput | null): HookOutput {
  if (output === null) throw new Error("Expected hook output");
  return output;
}

function requireContext(output: HookOutput): string {
  const hookSpecificOutput:
    | { readonly additionalContext: string; readonly hookEventName: string }
    | undefined = output.hookSpecificOutput;
  if (hookSpecificOutput === undefined) throw new Error("Expected hook context");
  return hookSpecificOutput.additionalContext;
}

test("derives a stable agent ID from machine, client, and workspace", (): void => {
  const environment: NodeJS.ProcessEnv = {
    MURMUR_MACHINE_ID: "dev vm",
    MURMUR_WORKSPACE_ID: "cancun-v1",
  };
  const first: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment);
  const second: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment);
  const claude: AgentIdentity = deriveAgentIdentity("claude", "/work/murmur", environment);
  expect(first.agentId).toBe(second.agentId);
  expect(first.agentId).toStartWith("dev-vm:codex:cancun-v1:");
  expect(claude.agentId).not.toBe(first.agentId);
});

test("builds metadata-only notification output and a Claude terminal signal", (): void => {
  const identity: AgentIdentity = deriveAgentIdentity("claude", "/work/murmur", {
    MURMUR_MACHINE_ID: "vm",
  });
  const output: HookOutput = buildHookOutput({
    client: "claude",
    eventName: "UserPromptSubmit",
    identity,
    notification: "Murmur: 2 unread messages from mac:codex:work.",
  });
  expect(output.systemMessage).toContain("2 unread messages");
  expect(output.terminalSequence).toStartWith("\u001b]9;");
  const context: string = requireContext(output);
  expect(context).toContain(identity.agentId);
  expect(context).not.toContain("message body");
});

test("checks, debounces, and notifies again only for a newer inbox version", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-"));
  let checks: number = 0;
  let summary: InboxSummary = {
    inboxVersion: 1,
    messageCount: 1,
    senderIds: ["mac:claude:other"],
  };
  const checkInbox: () => Promise<InboxSummary> = async (): Promise<InboxSummary> => {
    checks += 1;
    return summary;
  };
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "vm",
  };
  try {
    const first: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "UserPromptSubmit" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    expect(requireOutput(first).systemMessage).toContain("1 unread message");
    const debounced: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_001 },
    );
    expect(debounced).toBeNull();
    expect(checks).toBe(1);

    const unchanged: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 40_000 },
    );
    expect(unchanged).toEqual({});
    summary = { inboxVersion: 2, messageCount: 2, senderIds: ["mac:claude:other"] };
    const newer: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      {
        cacheDirectory: directory,
        checkInbox,
        environment,
        now: 60_000,
      },
    );
    expect(requireOutput(newer).systemMessage).toContain("2 unread messages");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("debounces a failed remote check", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-failure-"));
  let checks: number = 0;
  const checkInbox: () => Promise<InboxSummary> = async (): Promise<InboxSummary> => {
    checks += 1;
    throw new Error("service unavailable");
  };
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "vm",
  };
  try {
    const firstCheck: Promise<HookOutput | null> = handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    await expect(firstCheck).rejects.toThrow("service unavailable");
    const debounced: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_001 },
    );
    expect(debounced).toBeNull();
    expect(checks).toBe(1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SessionStart supplies identity context and reports a missing token", async (): Promise<void> => {
  const output: HookOutput | null = await handleHook(
    { cwd: "/work/repo", hook_event_name: "SessionStart" },
    "codex",
    {
      environment: { HOME: "/tmp", MURMUR_MACHINE_ID: "vm" },
    },
  );
  const required: HookOutput = requireOutput(output);
  expect(required.systemMessage).toContain("MURMUR_API_TOKEN is not set");
  expect(requireContext(required)).toContain("vm:codex:repo:");
});

test("checks a real Streamable HTTP Murmur inbox", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-http-"));
  const token: string = "hook-test-token";
  const server: MurmurHttpServer = await startHttpServer({
    MURMUR_API_TOKEN: token,
    MURMUR_DB_PATH: join(directory, "messages.db"),
    MURMUR_HTTP_HOST: "127.0.0.1",
    PORT: "0",
  });
  try {
    const identity: AgentIdentity = deriveAgentIdentity("codex", directory, {
      MURMUR_MACHINE_ID: "test-machine",
    });
    const summary: InboxSummary = await checkRemoteInbox(identity, {
      timeoutMs: 2_000,
      token,
      url: server.mcpUrl.toString(),
    });
    expect(summary).toEqual({ inboxVersion: 0, messageCount: 0, senderIds: [] });
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("sanitizes identity parts and falls back for empty values", (): void => {
  const identity: AgentIdentity = deriveAgentIdentity("codex", "/work/repo", {
    MURMUR_MACHINE_ID: "!!!",
    MURMUR_WORKSPACE_ID: `${"x".repeat(60)} / ignored`,
  });
  expect(identity.machine).toBe("machine");
  expect(identity.workspace).toBe("x".repeat(50));
  expect(identity.workspaceHash).toHaveLength(10);
});

test("formats lifecycle output without leaking Stop context", (): void => {
  const identity: AgentIdentity = deriveAgentIdentity("codex", "/work/repo", {
    MURMUR_MACHINE_ID: "vm",
  });
  expect(buildHookOutput({ client: "codex", eventName: "PostToolUse", identity })).toEqual({});
  const stopped: HookOutput = buildHookOutput({
    client: "codex",
    eventName: "Stop",
    identity,
    notification: "Murmur: 1 unread message.",
  });
  expect(stopped.systemMessage).toContain("1 unread message");
  expect(stopped.hookSpecificOutput).toBeUndefined();
  expect(stopped.terminalSequence).toBeUndefined();
});

test("silently skips non-session hooks when the token is missing", async (): Promise<void> => {
  expect(
    await handleHook({ cwd: "/work/repo", hook_event_name: "PostToolUse" }, "claude", {
      environment: { HOME: "/tmp", MURMUR_MACHINE_ID: "vm" },
    }),
  ).toBeNull();
});

test("SessionStart bypasses debounce but unchanged inbox versions do not notify", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-session-start-"));
  let checks: number = 0;
  const checkInbox: () => Promise<InboxSummary> = async (): Promise<InboxSummary> => {
    checks += 1;
    return { inboxVersion: 0, messageCount: 0, senderIds: [] };
  };
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "vm",
  };
  try {
    const first: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    const sessionStart: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "SessionStart" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_001 },
    );
    expect(first).toEqual({});
    expect(requireContext(requireOutput(sessionStart))).toContain("vm:codex:repo:");
    expect(checks).toBe(2);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("recovers from corrupt hook cache and uses safe numeric environment fallbacks", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-corrupt-cache-"));
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    MURMUR_API_TOKEN: "test-token",
    MURMUR_HOOK_DEBOUNCE_MS: "invalid",
    MURMUR_HOOK_TIMEOUT_MS: "-1",
    MURMUR_MACHINE_ID: "vm",
  };
  let receivedTimeout: number = 0;
  const checkInbox: (
    identity: AgentIdentity,
    options: { readonly timeoutMs: number },
  ) => Promise<InboxSummary> = async (
    _identity: AgentIdentity,
    options: { readonly timeoutMs: number },
  ): Promise<InboxSummary> => {
    receivedTimeout = options.timeoutMs;
    return { inboxVersion: 1, messageCount: 1, senderIds: [] };
  };
  try {
    await handleHook({ cwd: "/work/repo", hook_event_name: "PostToolUse" }, "codex", {
      cacheDirectory: directory,
      checkInbox,
      environment,
      now: 20_000,
    });
    const cacheFile: string | undefined = readdirSync(directory).find((path: string): boolean =>
      path.endsWith(".json"),
    );
    if (cacheFile === undefined) throw new Error("Expected a hook cache file");
    writeFileSync(join(directory, cacheFile), "not-json");
    const recovered: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_001 },
    );
    expect(requireOutput(recovered).systemMessage).toBe("Murmur: 1 unread message.");
    expect(receivedTimeout).toBe(4_000);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("deduplicates sender IDs in hook notification text", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-senders-"));
  try {
    const output: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "UserPromptSubmit" },
      "codex",
      {
        cacheDirectory: directory,
        checkInbox: async (): Promise<InboxSummary> => ({
          inboxVersion: 2,
          messageCount: 2,
          senderIds: ["sender-a"],
        }),
        environment: {
          HOME: directory,
          MURMUR_API_TOKEN: "test-token",
          MURMUR_MACHINE_ID: "vm",
        },
        now: 20_000,
      },
    );
    expect(requireOutput(output).systemMessage).toBe("Murmur: 2 unread messages from sender-a.");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("advances the notification watermark one fetched page at a time", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-pages-"));
  const afterSequences: number[] = [];
  const checkInbox: (
    identity: AgentIdentity,
    options: {
      readonly afterSequence: number;
      readonly timeoutMs: number;
      readonly token: string;
      readonly url: string;
    },
  ) => Promise<InboxSummary> = async (
    _identity: AgentIdentity,
    options: { readonly afterSequence: number },
  ): Promise<InboxSummary> => {
    afterSequences.push(options.afterSequence);
    return options.afterSequence === 0
      ? { inboxVersion: 100, messageCount: 100, senderIds: ["sender-a"] }
      : { inboxVersion: 101, messageCount: 1, senderIds: ["sender-b"] };
  };
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "vm",
  };
  try {
    const first: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    const second: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 40_000 },
    );
    expect(requireOutput(first).systemMessage).toContain("100 unread messages");
    expect(requireOutput(second).systemMessage).toContain("1 unread message");
    expect(afterSequences).toEqual([0, 100]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
