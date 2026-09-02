import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

import type { TimeSource } from "../src/http/http-capacity.js";
import { streamRotationDelay } from "../src/http/remote-stream-lifecycle.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { createHttpObservability } from "../src/observability/request-observation.js";
import { type LogOutput, StructuredLogger } from "../src/observability/structured-logger.js";
import { createTelemetry } from "../src/observability/telemetry.js";
import {
  initializeSession,
  postJson,
  requestHeaders,
  testEnvironment,
} from "./support/http-mcp-harness.js";

const SdkRotationResultSchema: z.ZodType<{
  readonly get_requests: number;
  readonly inbox_message_count: number;
  readonly notification_received: true;
  readonly session_retained: true;
  readonly tool_count: number;
}> = z.strictObject({
  get_requests: z.number().int().min(2),
  inbox_message_count: z.number().int().positive(),
  notification_received: z.literal(true),
  session_retained: z.literal(true),
  tool_count: z.number().int().positive(),
});
const RotationLogSchema: z.ZodType<{
  readonly duration_ms: number;
  readonly response_finish: "completed";
  readonly session_hash: string;
  readonly stream_rotated: true;
}> = z.object({
  duration_ms: z.number().nonnegative(),
  response_finish: z.literal("completed"),
  session_hash: z.string().min(1),
  stream_rotated: z.literal(true),
});
const SDK_ROTATION_PROCESS_TIMEOUT_MS: number = 15_000;

type SdkRotationChild = Bun.Subprocess<"ignore", "pipe", "pipe">;
type SdkRotationChildResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

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

async function sdkRotationChildResult(child: SdkRotationChild): Promise<SdkRotationChildResult> {
  const completed: Promise<SdkRotationChildResult> = Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]).then(
    ([exitCode, stderr, stdout]: [number, string, string]): SdkRotationChildResult => ({
      exitCode,
      stderr,
      stdout,
    }),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired: Promise<SdkRotationChildResult> = new Promise(
    (_resolve: (result: SdkRotationChildResult) => void, reject: (reason: Error) => void): void => {
      timeout = setTimeout((): void => {
        reject(new Error("SDK rotation subprocess timed out"));
      }, SDK_ROTATION_PROCESS_TIMEOUT_MS);
      timeout.unref();
    },
  );
  try {
    return await Promise.race([completed, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

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
    MURMUR_MAX_STREAM_LIFETIME_MS: "2000",
    MURMUR_SESSION_IDLE_MS: "1000",
  };
  const token: string | undefined = environment["MURMUR_API_TOKEN"];
  if (token === undefined) throw new Error("The SDK rotation test token is missing");
  const server: MurmurHttpServer = await startHttpServer(environment);
  let child: SdkRotationChild | null = null;
  try {
    child = Bun.spawn(
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
    const childResult: SdkRotationChildResult = await sdkRotationChildResult(child);
    expect(childResult.exitCode).toBe(0);
    expect(childResult.stderr).toBe("");
    const sdkResult: z.infer<typeof SdkRotationResultSchema> = SdkRotationResultSchema.parse(
      JSON.parse(childResult.stdout),
    );
    expect(sdkResult.get_requests).toBeGreaterThanOrEqual(2);
    expect(sdkResult.inbox_message_count).toBeGreaterThan(0);
    expect(sdkResult.notification_received).toBe(true);
    expect(sdkResult.session_retained).toBe(true);
    expect(sdkResult.tool_count).toBeGreaterThan(0);
  } finally {
    if (child !== null) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP rotates concurrent streams before the upstream deadline", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-rotation-"));
  const time: StreamTimeSource = new StreamTimeSource();
  const environment: NodeJS.ProcessEnv = {
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_LOG_LEVEL: "info",
    MURMUR_MAX_ACTIVE_STREAMS: "3",
    MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "3",
    MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "3",
    MURMUR_MAX_STREAM_LIFETIME_MS: "25",
    MURMUR_RELEASE_REVISION: "a".repeat(40),
  };
  const output: CapturingLogOutput = new CapturingLogOutput();
  const server: MurmurHttpServer = await startHttpServer(environment, {
    observability: createHttpObservability(
      new StructuredLogger(environment, output),
      createTelemetry(environment),
      time,
    ),
    timeSource: time,
  });
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
    const rotationLines: string[] = output.infos.filter((line: string): boolean =>
      line.includes('"stream_rotated":true'),
    );
    expect(rotationLines).toHaveLength(sessionIds.length);
    rotationLines.forEach((line: string): void => {
      const rotation: z.infer<typeof RotationLogSchema> = RotationLogSchema.parse(JSON.parse(line));
      expect(rotation.duration_ms).toBeGreaterThanOrEqual(25);
      expect(rotation.response_finish).toBe("completed");
      expect(rotation.stream_rotated).toBe(true);
      expect(sessionIds).not.toContain(rotation.session_hash);
      sessionIds.forEach((sessionId: string): void => {
        expect(line).not.toContain(sessionId);
      });
    });

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
    initialControllers.forEach((controller: AbortController): void => {
      controller.abort();
    });
    replacementControllers.forEach((controller: AbortController): void => {
      controller.abort();
    });
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
