import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  initializeSession,
  postJson,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

test("remote MCP preserves the legacy hook inbox shape during deploy skew", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-old-hook-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const sessionId: string = await initializeSession(server.mcpUrl, "murmur-hook", "0.1.0");
    const registrationResponse: Response = await postJson(
      server.mcpUrl,
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "old-hook", display_name: "Old Hook" },
          name: "register_agent",
        },
      },
      sessionId,
    );
    expect(registrationResponse.status).toBe(200);
    const serializedRegistration: string = JSON.stringify(
      await responsePayload(registrationResponse),
    );
    expect(serializedRegistration).toContain('"generation":1');
    expect(serializedRegistration).not.toContain('"authority"');
    await postJson(
      server.mcpUrl,
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            content: "deploy-skew message",
            recipient_id: "old-hook",
            sender_id: "old-hook",
          },
          name: "send_message",
        },
      },
      sessionId,
    );
    const inboxResponse: Response = await postJson(
      server.mcpUrl,
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "old-hook", limit: 100, unread_only: false },
          name: "get_messages",
        },
      },
      sessionId,
    );
    expect(inboxResponse.status).toBe(200);
    const serialized: string = JSON.stringify(await responsePayload(inboxResponse));
    expect(serialized).toContain("deploy-skew message");
    expect(serialized).not.toContain("sender_authority");
    expect(serialized).not.toContain("message_kind");
    expect(serialized).not.toContain("orchestrator_policy_id");
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
