import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  initializeSession,
  postJson,
  requestHeaders,
  testEnvironment,
} from "./support/http-mcp-harness.js";

test("remote MCP keeps request capacity available while bounding long-lived streams", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-capacity-"));
  const server: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_MAX_ACTIVE_REQUESTS: "1",
    MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1",
    MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "1",
    MURMUR_MAX_ACTIVE_STREAMS: "1",
    MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "1",
    MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "1",
  });
  const streamAbortController: AbortController = new AbortController();
  const recoveredStreamAbortController: AbortController = new AbortController();
  try {
    const sessionId: string = await initializeSession(server.mcpUrl);
    const streamResponse: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(sessionId),
      signal: streamAbortController.signal,
    });
    expect(streamResponse.status).toBe(200);

    const available: Response = await postJson(
      server.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(available.status).toBe(200);

    const registered: Response = await postJson(
      server.mcpUrl,
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "capacity-agent", display_name: "Capacity Agent" },
          name: "register_agent",
        },
      },
      sessionId,
    );
    expect(registered.status).toBe(200);
    const waitingRequest: Promise<Response> = postJson(
      server.mcpUrl,
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "capacity-agent", timeout_seconds: 1 },
          name: "wait_for_messages",
        },
      },
      sessionId,
    );
    await Bun.sleep(25);
    const limitedRequest: Response = await postJson(
      server.mcpUrl,
      { id: 5, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(limitedRequest.status).toBe(503);
    expect(await limitedRequest.json()).toEqual({ error: "MCP request capacity reached" });
    const completedRequest: Response = await waitingRequest;
    expect(completedRequest.status).toBe(200);
    await completedRequest.text();
    const recoveredRequest: Response = await postJson(
      server.mcpUrl,
      { id: 6, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(recoveredRequest.status).toBe(200);

    const secondSessionId: string = await initializeSession(server.mcpUrl);
    const limitedStream: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(secondSessionId),
    });
    expect(limitedStream.status).toBe(503);
    expect(limitedStream.headers.get("retry-after")).toBe("1");
    expect(await limitedStream.json()).toEqual({ error: "MCP stream capacity reached" });

    streamAbortController.abort();
    await Bun.sleep(25);
    const recoveredStream: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(secondSessionId),
      signal: recoveredStreamAbortController.signal,
    });
    expect(recoveredStream.status).toBe(200);
  } finally {
    streamAbortController.abort();
    recoveredStreamAbortController.abort();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
