import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { startHttpServer, type MurmurHttpServer } from "../src/http-server.js";

const API_TOKEN: string = "test-murmur-api-token";
const JsonRpcEnvelopeSchema: z.ZodObject<{
  result: z.ZodType<unknown>;
}> = z.object({ result: z.unknown() });

function testEnvironment(databasePath: string): NodeJS.ProcessEnv {
  return {
    MURMUR_API_TOKEN: API_TOKEN,
    MURMUR_DB_PATH: databasePath,
    MURMUR_HTTP_HOST: "127.0.0.1",
    PORT: "0",
  };
}

function requestHeaders(sessionId: string | null = null): Headers {
  const headers: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "feature/http-context",
    "X-Murmur-Client": "claude",
    "X-Murmur-Repository": "mattpatagon/murmur",
  });
  if (sessionId !== null) {
    headers.set("Mcp-Session-Id", sessionId);
    headers.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return headers;
}

async function postJson(
  url: URL,
  body: Record<string, unknown>,
  sessionId: string | null,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: requestHeaders(sessionId),
    method: "POST",
  });
}

async function responsePayload(response: Response): Promise<unknown> {
  const text: string = await response.text();
  const contentType: string = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const dataLines: string[] = text
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "));
  const lastLine: string | undefined = dataLines.at(-1);
  if (lastLine === undefined) throw new Error("MCP SSE response did not include a data event");
  return JSON.parse(lastLine.slice("data: ".length));
}

async function initializeSession(url: URL): Promise<string> {
  const response: Response = await postJson(
    url,
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "remote-test", version: "1.0.0" },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    },
    null,
  );
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await responsePayload(response));
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("MCP initialize response did not include a session ID");
  const initialized: Response = await postJson(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expect(initialized.status).toBe(202);
  return sessionId;
}

test("remote MCP requires a bearer token", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const healthUrl: URL = new URL("/health", server.mcpUrl);
    const healthResponse: Response = await fetch(healthUrl);
    expect(healthResponse.status).toBe(200);
    const response: Response = await fetch(server.mcpUrl, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="murmur"');
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP serves tools with repository context", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const sessionId: string = await initializeSession(server.mcpUrl);
    const streamAbortController: AbortController = new AbortController();
    const streamResponse: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(sessionId),
      signal: streamAbortController.signal,
    });
    expect(streamResponse.status).toBe(200);
    const streamBody: ReadableStream<Uint8Array> | null = streamResponse.body;
    if (streamBody === null) throw new Error("MCP SSE response did not include a body");
    const streamReader: ReadableStreamDefaultReader<Uint8Array> = streamBody.getReader();
    const firstChunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
      await Promise.race([
        streamReader.read(),
        Bun.sleep(3_000).then((): never => {
          throw new Error("MCP SSE keepalive timed out");
        }),
      ]);
    if (firstChunk.done || firstChunk.value === undefined) {
      throw new Error("MCP SSE stream closed before its first keepalive");
    }
    expect(new TextDecoder().decode(firstChunk.value)).toContain(": keepalive");
    streamAbortController.abort();

    const toolsResponse: Response = await postJson(
      server.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    const toolsPayload: unknown = await responsePayload(toolsResponse);
    expect(JSON.stringify(toolsPayload)).toContain("send_message");

    const calls: readonly Record<string, unknown>[] = [
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "remote-a", display_name: "Remote A" },
          name: "register_agent",
        },
      },
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "remote-b", display_name: "Remote B" },
          name: "register_agent",
        },
      },
    ];
    let callIndex: number = 0;
    while (callIndex < calls.length) {
      const call: Record<string, unknown> | undefined = calls[callIndex];
      if (call === undefined) throw new Error("Remote MCP call disappeared during iteration");
      const response: Response = await postJson(server.mcpUrl, call, sessionId);
      expect(response.status).toBe(200);
      callIndex += 1;
    }

    const sentResponse: Response = await postJson(
      server.mcpUrl,
      {
        id: 5,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            content: "hello over HTTP",
            recipient_id: "remote-b",
            sender_id: "remote-a",
          },
          name: "send_message",
        },
      },
      sessionId,
    );
    const sentEnvelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
      await responsePayload(sentResponse),
    );
    const sentResult: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(
      sentEnvelope.result,
    );
    expect(sentResult.isError).not.toBe(true);
    expect(JSON.stringify(sentResult.structuredContent)).toContain("mattpatagon/murmur");
    expect(JSON.stringify(sentResult.structuredContent)).toContain("feature/http-context");
    expect(JSON.stringify(sentResult.structuredContent)).toContain('"client":"claude"');
    expect(JSON.stringify(sentResult.structuredContent)).toContain("created_at");
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
