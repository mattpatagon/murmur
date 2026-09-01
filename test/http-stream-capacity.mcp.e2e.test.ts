import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

import type { TimeSource } from "../src/http/http-capacity.js";
import { streamRotationDelay } from "../src/http/remote-stream-lifecycle.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  initializeSession,
  postJson,
  requestHeaders,
  testEnvironment,
} from "./support/http-mcp-harness.js";

const SdkRotationResultSchema: z.ZodType<{
  readonly get_requests: number;
  readonly session_retained: true;
  readonly tool_count: number;
}> = z.strictObject({
  get_requests: z.number().int().min(2),
  session_retained: z.literal(true),
  tool_count: z.number().int().positive(),
});

class StreamTimeSource implements TimeSource {
  private current: number = 0;
  private nextTaskId: number = 1;
  private readonly tasks: Map<number, { readonly deadline: number; readonly wake: () => void }> =
    new Map<number, { readonly deadline: number; readonly wake: () => void }>();

  public advance(milliseconds: number): void {
    this.current += milliseconds;
    const due: [number, { readonly deadline: number; readonly wake: () => void }][] = Array.from(
      this.tasks.entries(),
    ).filter(
      (entry: [number, { readonly deadline: number; readonly wake: () => void }]): boolean =>
        entry[1].deadline <= this.current,
    );
    for (const entry of due) {
      this.tasks.delete(entry[0]);
      entry[1].wake();
    }
  }

  public now(): number {
    return this.current;
  }

  public schedule(milliseconds: number, wake: () => void): () => void {
    const taskId: number = this.nextTaskId;
    this.nextTaskId += 1;
    this.tasks.set(taskId, { deadline: this.current + milliseconds, wake });
    return (): void => {
      this.tasks.delete(taskId);
    };
  }
}

function requiredResponse(responses: readonly Response[], index: number): Response {
  const response: Response | undefined = responses[index];
  if (response === undefined) throw new Error(`Response ${String(index)} is missing`);
  return response;
}

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
    const postAbortResponses: Response[] = await Promise.all([
      fetch(new URL("/health", server.mcpUrl)),
      postJson(
        server.mcpUrl,
        { id: 3, jsonrpc: "2.0", method: "tools/list", params: {} },
        secondSessionId,
      ),
    ]);
    const health: Response = requiredResponse(postAbortResponses, 0);
    const toolsAfterAbort: Response = requiredResponse(postAbortResponses, 1);
    expect(health.status).toBe(200);
    expect(toolsAfterAbort.status).toBe(200);
  } finally {
    streamAbortController.abort();
    recoveredStreamAbortController.abort();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("stream rotation is stable and staggered within the pre-timeout window", (): void => {
  const maximumLifetimeMs: number = 1_000;
  const delays: number[] = ["session-a", "session-b", "session-c", "session-d"].map(
    (sessionId: string): number => streamRotationDelay(sessionId, maximumLifetimeMs),
  );
  expect(delays.every((delay: number): boolean => delay >= 900 && delay <= 1_000)).toBe(true);
  expect(new Set<number>(delays).size).toBeGreaterThan(1);
  const firstDelay: number | undefined = delays[0];
  if (firstDelay === undefined) throw new Error("The first rotation delay is missing");
  expect(streamRotationDelay("session-a", maximumLifetimeMs)).toBe(firstDelay);
});

test("the supported SDK client reconnects after application-owned rotation", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-sdk-rotation-"));
  const environment: NodeJS.ProcessEnv = {
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_MAX_STREAM_LIFETIME_MS: "100",
  };
  const token: string | undefined = environment["MURMUR_API_TOKEN"];
  if (token === undefined) throw new Error("The SDK rotation test token is missing");
  const server: MurmurHttpServer = await startHttpServer(environment);
  try {
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      [
        process.execPath,
        "run",
        "test/support/sdk-stream-rotation-client.mjs",
        server.mcpUrl.href,
        token,
      ],
      {
        cwd: resolve("."),
        env: { PATH: process.env["PATH"] ?? "" },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr, stdout]: [number, string, string] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const result: z.infer<typeof SdkRotationResultSchema> = SdkRotationResultSchema.parse(
      JSON.parse(stdout),
    );
    expect(result.get_requests).toBeGreaterThanOrEqual(2);
    expect(result.session_retained).toBe(true);
    expect(result.tool_count).toBeGreaterThan(0);
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP rotates concurrent streams before the upstream deadline", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-rotation-"));
  const time: StreamTimeSource = new StreamTimeSource();
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_MAX_ACTIVE_STREAMS: "3",
      MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "3",
      MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "3",
      MURMUR_MAX_STREAM_LIFETIME_MS: "25",
      MURMUR_RELEASE_REVISION: "a".repeat(40),
    },
    { timeSource: time },
  );
  const initialControllers: AbortController[] = [];
  const replacementControllers: AbortController[] = [];
  try {
    const sessionIds: string[] = [];
    for (let index: number = 0; index < 3; index += 1) {
      sessionIds.push(await initializeSession(server.mcpUrl));
    }
    const initialStreams: Response[] = await Promise.all(
      sessionIds.map(async (sessionId: string): Promise<Response> => {
        const controller: AbortController = new AbortController();
        initialControllers.push(controller);
        return await fetch(server.mcpUrl, {
          headers: requestHeaders(sessionId),
          signal: controller.signal,
        });
      }),
    );
    expect(initialStreams.map((response: Response): number => response.status)).toEqual([
      200, 200, 200,
    ]);

    time.advance(25);
    const replacements: Response[] = await Promise.all(
      sessionIds.map(async (sessionId: string): Promise<Response> => {
        const controller: AbortController = new AbortController();
        replacementControllers.push(controller);
        return await openStreamAfterRelease(server.mcpUrl, sessionId, controller.signal);
      }),
    );
    expect(replacements.map((response: Response): number => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(
      replacements.map((response: Response): string | null =>
        response.headers.get("mcp-session-id"),
      ),
    ).toEqual(sessionIds);

    const healthUrl: URL = new URL("/health", server.mcpUrl);
    const versionUrl: URL = new URL("/version", server.mcpUrl);
    const firstSessionId: string | undefined = sessionIds[0];
    if (firstSessionId === undefined) throw new Error("The first test session is missing");
    const reachableResponses: Response[] = await Promise.all([
      fetch(healthUrl),
      fetch(versionUrl),
      postJson(
        server.mcpUrl,
        { id: 3, jsonrpc: "2.0", method: "tools/list", params: {} },
        firstSessionId,
      ),
    ]);
    const health: Response = requiredResponse(reachableResponses, 0);
    const version: Response = requiredResponse(reachableResponses, 1);
    const tools: Response = requiredResponse(reachableResponses, 2);
    expect(health.status).toBe(200);
    expect(version.status).toBe(200);
    expect(tools.status).toBe(200);
  } finally {
    initialControllers.forEach((controller: AbortController): void => controller.abort());
    replacementControllers.forEach((controller: AbortController): void => controller.abort());
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
