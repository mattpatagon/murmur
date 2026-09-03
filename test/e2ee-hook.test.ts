import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import { defaultE2eeVaultPath } from "../src/e2ee/vault-paths.js";
import {
  type AgentIdentity,
  checkRemoteInbox,
  deriveAgentIdentity,
  handleHook,
  type InboxSummary,
} from "../src/hook.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestMethod(input: Record<string, unknown>): string | null {
  const method: unknown = input["method"];
  return typeof method === "string" ? method : null;
}

function requestedTool(input: Record<string, unknown>): string | null {
  const params: unknown = input["params"];
  if (!isRecord(params)) return null;
  const name: unknown = params["name"];
  return typeof name === "string" ? name : null;
}

test("E2E hooks request only a content-free inbox summary", async (): Promise<void> => {
  const requests: string[] = [];
  const tools: string[] = [];
  let deleteCount: number = 0;
  const identity: AgentIdentity = deriveAgentIdentity("codex", "/work/e2ee-repo", {
    MURMUR_BRANCH: "feature/e2ee",
    MURMUR_MACHINE_ID: "test-machine",
    MURMUR_REPOSITORY: "mattpatagon/murmur",
  });
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      if (request.method === "DELETE") {
        deleteCount += 1;
        return new Response(null, { status: 204 });
      }
      const text: string = await request.text();
      requests.push(text);
      const input: unknown = JSON.parse(text);
      if (!isRecord(input)) return Response.json({ error: "invalid" }, { status: 400 });
      const id: unknown = input["id"];
      const method: string | null = requestMethod(input);
      if (method === "initialize") {
        return Response.json(
          {
            id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "e2ee-hook-test", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": "e2ee-hook-session" } },
        );
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/call") {
        const name: string | null = requestedTool(input);
        if (name !== null) tools.push(name);
        const structuredContent: Record<string, unknown> =
          name === "register_agent"
            ? {
                agent: {
                  agent_id: identity.agentId,
                  closed_at: null,
                  close_reason: null,
                  created_at: "2026-08-10T20:00:00.000Z",
                  display_name: identity.displayName,
                  generation: 1,
                  last_seen_at: "2026-08-10T20:00:00.000Z",
                  lease_expires_at: "2026-08-10T20:15:00.000Z",
                  live_session_count: 1,
                  metadata: {},
                  state: "active",
                },
                inbox_uri: `murmur://inbox/${encodeURIComponent(identity.agentId)}`,
                lease_minutes: 15,
                reopened: false,
                repository_diverged: false,
                retention_days: 30,
              }
            : name === "get_inbox_summary"
              ? {
                  agent_id: identity.agentId,
                  inbox_version: 42,
                  newest_sequence: 42,
                  unread_count: 3,
                }
              : {};
        return Response.json({
          id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: JSON.stringify(structuredContent), type: "text" }],
            structuredContent,
          },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 400 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const summary: InboxSummary = await checkRemoteInbox(identity, {
      afterSequence: 10,
      e2ee: true,
      timeoutMs: 2_000,
      token: "hook-test-token",
      url: `http://127.0.0.1:${server.port}/mcp`,
    });
    expect(summary).toEqual({
      agentGeneration: 1,
      inboxVersion: 42,
      messageCount: 3,
      orchestration: { kind: "unavailable" },
      senderIds: [],
    });
    expect(tools).toEqual(["register_agent", "get_orchestrator", "get_inbox_summary"]);
    expect(requests.join("\n")).not.toContain("get_messages");
    expect(requests.join("\n")).not.toContain("content");
    expect(deleteCount).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("hook mode is passed from local E2E setup without changing notification content", async (): Promise<void> => {
  const e2eeModes: boolean[] = [];
  const cwd: string = "/work/e2ee-repo";
  const cacheDirectory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-hook-mode-"));
  const identity: AgentIdentity = deriveAgentIdentity("codex", cwd, {
    MURMUR_MACHINE_ID: "test-machine",
  });
  expect(identity.agentId).toContain("test-machine:codex:e2ee-repo:");
  const check: (
    checkedIdentity: AgentIdentity,
    options: { readonly e2ee: boolean },
  ) => Promise<InboxSummary> = async (
    _checkedIdentity: AgentIdentity,
    options: { readonly e2ee: boolean },
  ): Promise<InboxSummary> => {
    e2eeModes.push(options.e2ee);
    return { agentGeneration: 1, inboxVersion: 0, messageCount: 0, senderIds: [] };
  };
  try {
    await handleHook({ cwd, hook_event_name: "SessionStart" }, "codex", {
      cacheDirectory,
      checkInbox: check,
      environment: {
        HOME: cacheDirectory,
        MURMUR_API_TOKEN: "test-token",
        MURMUR_E2EE: "1",
        MURMUR_MACHINE_ID: "test-machine",
      },
      now: 20_000,
    });
    expect(e2eeModes).toEqual([true]);
  } finally {
    rmSync(cacheDirectory, { force: true, recursive: true });
  }
});

test("the installed E2E hook retires its local identity at SessionEnd", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-hook-retire-"));
  const token: string = "e2ee-hook-retirement-token";
  const rawSessionId: string = "e2ee-host-session";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: directory,
    MURMUR_API_TOKEN: token,
    MURMUR_BRANCH: "feature/e2ee-hook-retirement",
    MURMUR_CACHE_DIR: join(directory, "cache"),
    MURMUR_HOOK_DEBUG: "1",
    MURMUR_MACHINE_ID: "test-machine",
    MURMUR_REPOSITORY: "mattpatagon/murmur",
    XDG_DATA_HOME: join(directory, "data"),
  };
  const identity: AgentIdentity = deriveAgentIdentity(
    "codex",
    directory,
    environment,
    rawSessionId,
  );
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const input: unknown = JSON.parse(await request.text());
      if (!isRecord(input)) return Response.json({ error: "invalid" }, { status: 400 });
      const id: unknown = input["id"];
      const method: string | null = requestMethod(input);
      if (method === "initialize") {
        return Response.json(
          {
            id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "e2ee-hook-retirement-test", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": "e2ee-hook-retirement-session" } },
        );
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      const name: string | null = requestedTool(input);
      const structuredContent: Record<string, unknown> =
        name === "register_agent"
          ? {
              agent: {
                agent_id: identity.agentId,
                closed_at: null,
                close_reason: null,
                created_at: "2026-09-03T00:00:00.000Z",
                display_name: identity.displayName,
                generation: 1,
                last_seen_at: "2026-09-03T00:00:00.000Z",
                lease_expires_at: "2026-09-03T01:00:00.000Z",
                live_session_count: 1,
                metadata: {},
                state: "active",
              },
              inbox_uri: `murmur://inbox/${encodeURIComponent(identity.agentId)}`,
              lease_minutes: 60,
              reopened: false,
              repository_diverged: false,
              retention_days: 30,
            }
          : name === "get_inbox_summary"
            ? {
                agent_id: identity.agentId,
                inbox_version: 1,
                newest_sequence: 1,
                unread_count: 0,
              }
            : {};
      return Response.json({
        id,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify(structuredContent), type: "text" }],
          structuredContent,
        },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  environment["MURMUR_MCP_URL"] = `http://127.0.0.1:${server.port}/mcp`;
  const defaultVaultPath: string = defaultE2eeVaultPath(environment, process.platform);
  const vaultPath: string = join(directory, "custom-vault", "vault.sqlite");
  const vault: LocalE2eeVault = new LocalE2eeVault(vaultPath, process.platform);
  try {
    const now: number = Date.now();
    await vault.keys.getOrCreateAgent(
      identity.agentId,
      new Date(now).toISOString(),
      new Date(now + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    );
    vault.close();
    const hookEvents: readonly ("SessionEnd" | "SessionStart")[] = ["SessionStart", "SessionEnd"];
    for (const eventName of hookEvents) {
      const child: Bun.ReadableSubprocess = Bun.spawn({
        cmd: [
          process.execPath,
          resolve("src/hook.ts"),
          "--client",
          "codex",
          "--e2ee",
          "--vault-path",
          vaultPath,
        ],
        cwd: process.cwd(),
        env: environment,
        stderr: "pipe",
        stdin: Buffer.from(
          JSON.stringify({ cwd: directory, hook_event_name: eventName, session_id: rawSessionId }),
        ),
        stdout: "pipe",
        timeout: 10_000,
      });
      const results: [number, string, string] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      const exitCode: number = results[0];
      const stderr: string = results[1];
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }
    const retired: LocalE2eeVault = new LocalE2eeVault(vaultPath, process.platform);
    try {
      retired.purgeExpired(new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString());
      expect(retired.keys.getAgent(identity.agentId)).toBeNull();
      expect(existsSync(defaultVaultPath)).toBe(false);
    } finally {
      retired.close();
    }
  } finally {
    vault.close();
    server.stop(true);
    rmSync(directory, { force: true, recursive: true });
  }
});
