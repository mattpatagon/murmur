import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkRemoteInbox,
  deriveAgentIdentity,
  handleHook,
  type AgentIdentity,
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
          name === "get_inbox_summary"
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
    expect(summary).toEqual({ inboxVersion: 42, messageCount: 3, senderIds: [] });
    expect(tools).toEqual(["register_agent", "get_inbox_summary"]);
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
    return { inboxVersion: 0, messageCount: 0, senderIds: [] };
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
