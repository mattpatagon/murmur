import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  initializeSession,
  postJson,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

test("owner GET at the physical stream ceiling closes the oldest body and preserves all MCP sessions", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-owner-stream-"));
  let server: MurmurHttpServer | null = null;
  const abort: AbortController = new AbortController();
  const readers: Promise<string>[] = [];
  try {
    server = await startHttpServer({
      ...testEnvironment(join(directory, "messages.sqlite")),
      MURMUR_OWNER_PRIORITY: "1",
      MURMUR_MAX_ACTIVE_STREAMS: "2",
      MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "1",
      MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "1",
    });
    const first: string = await initializeSession(server.mcpUrl, "first");
    const second: string = await initializeSession(server.mcpUrl, "second");
    const third: string = await initializeSession(server.mcpUrl, "third");
    const firstStream: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(first),
      signal: abort.signal,
    });
    expect(firstStream.status).toBe(200);
    const firstEnded: Promise<string> = firstStream.text();
    readers.push(firstEnded);
    const secondStream: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(second),
      signal: abort.signal,
    });
    expect(secondStream.status).toBe(200);
    const secondEnded: Promise<string> = secondStream.text();
    readers.push(secondEnded);
    const invalid: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(third, "invalid-owner"),
      signal: abort.signal,
    });
    expect(invalid.status).toBe(401);
    await invalid.text();
    const thirdStream: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(third),
      signal: abort.signal,
    });
    expect(thirdStream.status).toBe(200);
    expect(await firstEnded).toContain(": keepalive");
    for (const sessionId of [first, second, third]) {
      const ping: Response = await postJson(
        server.mcpUrl,
        { id: 2, jsonrpc: "2.0", method: "ping" },
        sessionId,
      );
      expect(ping.status).toBe(200);
      await responsePayload(ping);
    }
    const reconnected: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(first),
      signal: abort.signal,
    });
    expect(reconnected.status).toBe(200);
    expect(await secondEnded).toContain(": keepalive");
    if (thirdStream.body === null || reconnected.body === null)
      throw new Error("Missing SSE stream body");
    await Promise.all([thirdStream.body.cancel(), reconnected.body.cancel()]);
  } finally {
    abort.abort();
    await Promise.allSettled(readers);
    if (server !== null) await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
}, 15_000);
