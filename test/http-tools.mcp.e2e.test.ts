import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { createHttpObservability } from "../src/observability/request-observation.js";
import { type LogOutput, StructuredLogger } from "../src/observability/structured-logger.js";
import { createTelemetry } from "../src/observability/telemetry.js";
import {
  initializeSession,
  initializeRequest,
  JsonRpcEnvelopeSchema,
  postJson,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

class CapturingLogOutput implements LogOutput {
  public readonly errors: string[] = [];
  public readonly infos: string[] = [];

  public error(line: string): void {
    this.errors.push(line);
  }

  public info(line: string): void {
    this.infos.push(line);
  }
}

async function postForRepository(
  url: URL,
  body: Record<string, unknown>,
  repository: string,
  sessionId: string | null,
): Promise<Response> {
  const headers: Headers = requestHeaders(sessionId);
  headers.set("X-Murmur-Repository", repository);
  return await fetch(url, { body: JSON.stringify(body), headers, method: "POST" });
}

async function initializeForRepository(url: URL, repository: string): Promise<string> {
  const response: Response = await postForRepository(url, initializeRequest(90), repository, null);
  expect(response.status).toBe(200);
  await responsePayload(response);
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Repository session did not receive an MCP session ID");
  const initialized: Response = await postForRepository(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    repository,
    sessionId,
  );
  expect(initialized.status).toBe(202);
  return sessionId;
}

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

test("repository divergence emits one caller-free structured event", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-lifecycle-observability-"));
  const environment: NodeJS.ProcessEnv = {
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_LOG_LEVEL: "info",
  };
  const output: CapturingLogOutput = new CapturingLogOutput();
  const server: MurmurHttpServer = await startHttpServer(environment, {
    observability: createHttpObservability(
      new StructuredLogger(environment, output),
      createTelemetry(environment),
    ),
  });
  const agentId: string = "divergent-agent-secret";
  const repositoryA: string = "owner/private-repository-a";
  const repositoryB: string = "owner/private-repository-b";
  try {
    const sessionA: string = await initializeForRepository(server.mcpUrl, repositoryA);
    const sessionB: string = await initializeForRepository(server.mcpUrl, repositoryB);
    const first: Response = await postForRepository(
      server.mcpUrl,
      {
        id: 91,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: agentId, session_key: "pane-a" },
          name: "register_agent",
        },
      },
      repositoryA,
      sessionA,
    );
    expect(first.status).toBe(200);
    await responsePayload(first);
    const divergent: Response = await postForRepository(
      server.mcpUrl,
      {
        id: 92,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: agentId, session_key: "pane-b" },
          name: "register_agent",
        },
      },
      repositoryB,
      sessionB,
    );
    expect(divergent.status).toBe(200);
    expect(JSON.stringify(await responsePayload(divergent))).toContain(
      '"repository_diverged":true',
    );
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
  const divergenceEvents: string[] = output.infos.filter((line: string): boolean =>
    line.includes('"event":"agent.repository_divergence"'),
  );
  expect(divergenceEvents).toHaveLength(1);
  const event: string | undefined = divergenceEvents[0];
  if (event === undefined) throw new Error("Repository divergence event was not emitted");
  expect(event).not.toContain(agentId);
  expect(event).not.toContain(repositoryA);
  expect(event).not.toContain(repositoryB);
});
