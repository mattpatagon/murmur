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

async function openStreamAfterRelease(
  url: URL,
  sessionId: string,
  signal: AbortSignal,
): Promise<Response> {
  const maximumAttempts: number = 100;
  for (let attempt: number = 0; attempt < maximumAttempts; attempt += 1) {
    const response: Response = await fetch(url, {
      headers: requestHeaders(sessionId),
      signal,
    });
    if (response.status === 200) return response;
    const body: string = await response.text();
    if (response.status !== 503) {
      throw new Error(`Unexpected stream recovery status ${response.status}: ${body}`);
    }
  }
  throw new Error(`Stream capacity was not released after ${maximumAttempts} attempts`);
}

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

    const secondSessionId: string = await initializeSession(server.mcpUrl);
    const limitedStream: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(secondSessionId),
    });
    expect(limitedStream.status).toBe(503);
    expect(limitedStream.headers.get("retry-after")).toBe("1");
    expect(await limitedStream.json()).toEqual({ error: "MCP stream capacity reached" });

    streamAbortController.abort();
    const recoveredStream: Response = await openStreamAfterRelease(
      server.mcpUrl,
      secondSessionId,
      recoveredStreamAbortController.signal,
    );
    expect(recoveredStream.status).toBe(200);
  } finally {
    streamAbortController.abort();
    recoveredStreamAbortController.abort();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
