import { expect, test } from "bun:test";
import type { Server } from "bun";
import { z } from "zod";

import type { LoadTenant } from "../scripts/lib/hosted-load-fixture.js";
import { LoadHttpClient } from "../scripts/lib/hosted-load-http.js";
import {
  LOAD_HTTP_RUNTIME,
  type LoadHttpRuntime,
} from "../scripts/lib/hosted-load-http-runtime.js";
import { LoadPhase, type PhaseReport } from "../scripts/lib/hosted-load-metrics.js";
import { generateTokenSecret } from "../src/hosted/token-secret.js";

const requestBody: Record<string, unknown> = {
  id: 2,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name: "get_messages", arguments: { agent_id: "reader" } },
};
const success: Record<string, unknown> = { id: 2, jsonrpc: "2.0", result: { accepted: true } };

function capacityPayload(kind: "processing" | "materialization"): Record<string, unknown> {
  return {
    id: 2,
    jsonrpc: "2.0",
    error: {
      code: -32003,
      message: `MCP error -32003: MCP ${kind} capacity reached; retry later.`,
      data: { retryable: true, retry_after_ms: 1000 },
    },
  };
}

function sseResponse(value: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("load HTTP retries an actual SSE capacity response and retains its status and end-to-end latency", async (): Promise<void> => {
  let requests: number = 0;
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (): Response => {
      requests += 1;
      return sseResponse(requests === 1 ? capacityPayload("processing") : success);
    },
  });
  const phase: LoadPhase = new LoadPhase("capacity-regression", 1);
  let elapsed: number = 0;
  const runtime: LoadHttpRuntime = {
    fetch: LOAD_HTTP_RUNTIME.fetch,
    now: (): number => elapsed,
    wait: async (milliseconds: number, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      elapsed += milliseconds;
    },
  };
  const client: LoadHttpClient = new LoadHttpClient(
    new URL("/mcp", server.url),
    phase,
    new AbortController().signal,
    runtime,
  );
  try {
    const result: Awaited<ReturnType<LoadHttpClient["request"]>> = await client.request(
      "fixture-token",
      "fixture-session",
      requestBody,
      "POST",
      [200],
    );
    expect(result.payload).toEqual(success);
    expect(requests).toBe(2);
    const report: PhaseReport = phase.report();
    expect(report.statusCodes).toEqual({ "200": 2 });
    expect(report.httpAttempts).toBe(2);
    expect(report.retries).toBe(1);
    expect(report.mcpCapacityResponses).toBe(1);
    expect(report.operations).toBe(1);
    expect(report.operationP95Ms).toBeGreaterThanOrEqual(1000);
  } finally {
    await server.stop(true);
  }
});

type Reply = {
  readonly value: unknown;
  readonly status?: number;
  readonly duration?: number;
  readonly retryAfter?: string;
};

class ScriptedRuntime implements LoadHttpRuntime {
  public elapsed: number = 0;
  public fetchCalls: number = 0;
  public readonly waits: number[] = [];
  public afterWait: (signal: AbortSignal) => Promise<void> = async (): Promise<void> => {};

  public constructor(private readonly replies: readonly Reply[]) {}

  public now(): number {
    return this.elapsed;
  }

  public async fetch(_url: URL, options: RequestInit): Promise<Response> {
    const reply: Reply | undefined = this.replies[this.fetchCalls];
    this.fetchCalls += 1;
    if (reply === undefined) throw new Error("Unexpected fixture HTTP attempt");
    if (options.signal !== undefined && options.signal !== null) options.signal.throwIfAborted();
    this.elapsed += reply.duration ?? 0;
    const headers: Headers = new Headers({ "content-type": "application/json" });
    if (reply.retryAfter !== undefined) headers.set("retry-after", reply.retryAfter);
    return new Response(JSON.stringify(reply.value), { status: reply.status ?? 200, headers });
  }

  public async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.waits.push(milliseconds);
    this.elapsed += milliseconds;
    await this.afterWait(signal);
  }
}

function fixture(
  replies: readonly Reply[],
  controller: AbortController = new AbortController(),
): {
  readonly client: LoadHttpClient;
  readonly phase: LoadPhase;
  readonly runtime: ScriptedRuntime;
} {
  const phase: LoadPhase = new LoadPhase("deterministic-capacity", 1);
  const runtime: ScriptedRuntime = new ScriptedRuntime(replies);
  return {
    client: new LoadHttpClient(
      new URL("http://127.0.0.1:1/mcp"),
      phase,
      controller.signal,
      runtime,
    ),
    phase,
    runtime,
  };
}

async function request(client: LoadHttpClient, retry: boolean = true): Promise<unknown> {
  return await client.request(
    "fixture-token",
    "fixture-session",
    requestBody,
    "POST",
    [200],
    retry,
  );
}

test("both capacity kinds and HTTP overload preserve every attempt and total retry latency", async (): Promise<void> => {
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([
    { value: { error: "overload" }, status: 429, retryAfter: "0.2", duration: 10 },
    { value: capacityPayload("processing"), duration: 20, retryAfter: "86400" },
    { value: capacityPayload("materialization"), duration: 30 },
    { value: success, duration: 40 },
  ]);
  await request(client);
  expect(runtime.waits).toEqual([200, 1007, 1014]);
  const report: PhaseReport = phase.report();
  expect(report.httpAttempts).toBe(4);
  expect(report.statusCodes).toEqual({ "200": 3, "429": 1 });
  expect(report.mcpCapacityResponses).toBe(2);
  expect(report.retries).toBe(3);
  expect(report.operations).toBe(1);
  expect(report.operationP50Ms).toBe(2321);
  expect(report.operationP95Ms).toBe(2321);
  expect(report.operationP99Ms).toBe(2321);
  expect(report.attemptP95Ms).toBe(40);
});

test("the eighth capacity response fails without a ninth attempt or a successful operation", async (): Promise<void> => {
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture(
    Array.from({ length: 8 }, (): Reply => ({ value: capacityPayload("materialization") })),
  );
  await expect(request(client)).rejects.toThrow("Load MCP capacity exhausted its bounded retries");
  expect(runtime.fetchCalls).toBe(8);
  expect(runtime.waits).toHaveLength(7);
  const report: PhaseReport = phase.report();
  expect(report.statusCodes).toEqual({ "200": 8 });
  expect(report.mcpCapacityResponses).toBe(8);
  expect(report.retries).toBe(7);
  expect(report.operations).toBe(0);
});

test("retry-disabled capacity errors remain counted and fail without backoff", async (): Promise<void> => {
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([
    { value: capacityPayload("processing") },
  ]);
  await expect(request(client, false)).rejects.toThrow(
    "Load MCP capacity exhausted its bounded retries",
  );
  expect(runtime.fetchCalls).toBe(1);
  expect(runtime.waits).toEqual([]);
  expect(phase.report().mcpCapacityResponses).toBe(1);
  expect(phase.report().retries).toBe(0);
  expect(phase.report().operations).toBe(0);
});

test("backoff jitter cannot cross the original 15-second deadline", async (): Promise<void> => {
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([
    { value: { error: "overload" }, status: 503, retryAfter: "8", duration: 5000 },
    { value: capacityPayload("processing"), duration: 994 },
  ]);
  await expect(request(client)).rejects.toThrow("Load retry exceeds its bounded request deadline");
  expect(runtime.elapsed).toBe(13994);
  expect(runtime.waits).toEqual([8000]);
  expect(phase.report().statusCodes).toEqual({ "200": 1, "503": 1 });
  expect(phase.report().mcpCapacityResponses).toBe(1);
  expect(phase.report().retries).toBe(1);
  expect(phase.report().operations).toBe(0);
});

test("an overscheduled wait cannot start an HTTP attempt after the absolute deadline", async (): Promise<void> => {
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([
    { value: capacityPayload("processing") },
  ]);
  runtime.afterWait = async (): Promise<void> => {
    runtime.elapsed = 15_000;
  };
  await expect(request(client)).rejects.toThrow(
    "Load request exceeded its bounded request deadline",
  );
  expect(runtime.fetchCalls).toBe(1);
  expect(phase.report().operations).toBe(0);
});

test("a completed HTTP response at the total deadline remains counted but cannot declare success", async (): Promise<void> => {
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([
    { value: success, duration: 15_000 },
  ]);
  await expect(request(client)).rejects.toThrow(
    "Load request exceeded its bounded request deadline",
  );
  expect(runtime.fetchCalls).toBe(1);
  expect(phase.report().statusCodes).toEqual({ "200": 1 });
  expect(phase.report().operations).toBe(0);
});

test("already aborted requests make no attempt and expected saturation responses remain unchanged", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  controller.abort();
  const aborted: ReturnType<typeof fixture> = fixture([], controller);
  await expect(request(aborted.client)).rejects.toThrow();
  expect(aborted.runtime.fetchCalls).toBe(0);
  expect(aborted.phase.report().httpAttempts).toBe(0);
  const saturation: ReturnType<typeof fixture> = fixture([
    { status: 503, value: { error: "MCP session capacity reached" } },
  ]);
  await saturation.client.request("fixture-token", null, requestBody, "POST", [503], false);
  expect(saturation.runtime.fetchCalls).toBe(1);
  expect(saturation.runtime.waits).toEqual([]);
  expect(saturation.phase.report().mcpCapacityResponses).toBe(0);
  expect(saturation.phase.report().operations).toBe(1);
});

test("cancellation interrupts the real backoff wait and does not issue another HTTP request", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  const { client, phase, runtime }: ReturnType<typeof fixture> = fixture(
    [{ value: capacityPayload("processing") }],
    controller,
  );
  runtime.afterWait = async (signal: AbortSignal): Promise<void> => {
    const pending: Promise<void> = LOAD_HTTP_RUNTIME.wait(10_000, signal);
    controller.abort();
    await pending;
  };
  await expect(request(client)).rejects.toThrow();
  expect(runtime.fetchCalls).toBe(1);
  expect(phase.report().statusCodes).toEqual({ "200": 1 });
  expect(phase.report().mcpCapacityResponses).toBe(1);
  expect(phase.report().operations).toBe(0);
});

test("arbitrary MCP, tool, schema and malformed capacity failures are not retried", async (): Promise<void> => {
  const error: Record<string, unknown> = {
    code: -32003,
    message: "MCP error -32003: MCP processing capacity reached; retry later.",
    data: { retryable: true, retry_after_ms: 1000 },
  };
  const invalid: unknown[] = [
    { id: 3, jsonrpc: "2.0", error },
    { id: "2", jsonrpc: "2.0", error },
    { id: 2, jsonrpc: "1.0", error },
    { id: 2, jsonrpc: "2.0", error: { ...error, code: -32602 } },
    { id: 2, jsonrpc: "2.0", error: { ...error, message: "private-fixture-sentinel" } },
    {
      id: 2,
      jsonrpc: "2.0",
      error: { ...error, data: { retryable: false, retry_after_ms: 1000 } },
    },
    {
      id: 2,
      jsonrpc: "2.0",
      error: { ...error, data: { retryable: true, retry_after_ms: "1000" } },
    },
    { id: 2, jsonrpc: "2.0", error: { ...error, data: { retryable: true, retry_after_ms: 999 } } },
    { id: 2, jsonrpc: "2.0", error: { ...error, data: { retryable: true, retry_after_ms: 1001 } } },
    {
      id: 2,
      jsonrpc: "2.0",
      error: { ...error, data: { retryable: true, retry_after_ms: 1000, extra: 1 } },
    },
    { id: 2, jsonrpc: "2.0", error, result: {} },
    {
      id: 2,
      jsonrpc: "2.0",
      result: { isError: true, content: [{ type: "text", text: "fixture failure" }] },
    },
    { id: 2, jsonrpc: "2.0", result: { content: [], structuredContent: { accepted: "invalid" } } },
  ];
  const tenant: LoadTenant = {
    id: "fixture-tenant",
    index: 0,
    token: generateTokenSecret("mur"),
    tokenId: "fixture-token-id",
  };
  for (const value of invalid) {
    const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([{ value }]);
    await expect(
      client.tool(
        tenant,
        "fixture-session",
        "get_messages",
        {},
        z.strictObject({ accepted: z.boolean() }),
      ),
    ).rejects.toThrow();
    expect(runtime.fetchCalls).toBe(1);
    expect(runtime.waits).toEqual([]);
    expect(phase.report().mcpCapacityResponses).toBe(0);
    expect(phase.report().statusCodes).toEqual({ "200": 1 });
  }
});

test("authentication and non-overload HTTP errors never trigger MCP capacity retries", async (): Promise<void> => {
  for (const status of [400, 401, 403, 404, 500]) {
    const { client, phase, runtime }: ReturnType<typeof fixture> = fixture([
      { status, value: capacityPayload("processing") },
    ]);
    await expect(request(client)).rejects.toThrow(`Unexpected hosted load HTTP status ${status}`);
    expect(runtime.fetchCalls).toBe(1);
    expect(runtime.waits).toEqual([]);
    expect(phase.report().mcpCapacityResponses).toBe(0);
    expect(phase.report().operations).toBe(0);
  }
});

test("load HTTP failure diagnostics preserve received status and redact fetch, read and parse failures", async (): Promise<void> => {
  const secret: string = "private-load-exception-sentinel";
  const cases: readonly {
    readonly stage: "fetch" | "body-read" | "body-parse";
    readonly status: number;
    readonly label: string;
    readonly error: unknown;
  }[] = [
    ...["ConnectionClosed", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ABORT_ERR"].map(
      (code: string): { stage: "fetch"; status: number; label: string; error: Error } => ({
        stage: "fetch",
        status: 0,
        label: code,
        error: Object.assign(new Error(secret), { code }),
      }),
    ),
    ...["AbortError", "TimeoutError", "TypeError"].map(
      (name: string): { stage: "fetch"; status: number; label: string; error: Error } => ({
        stage: "fetch",
        status: 0,
        label: name,
        error: Object.assign(new Error(secret), { name }),
      }),
    ),
    { stage: "fetch", status: 0, label: "unclassified", error: { name: "ECONNRESET", secret } },
    {
      stage: "fetch",
      status: 0,
      label: "unclassified",
      error: Object.assign(new Error(secret), { name: secret, code: secret, stack: secret }),
    },
    {
      stage: "body-read",
      status: 503,
      label: "ECONNRESET",
      error: Object.assign(new Error(secret), { code: "ECONNRESET" }),
    },
    { stage: "body-parse", status: 200, label: "SyntaxError", error: null },
    { stage: "body-parse", status: 503, label: "SyntaxError", error: null },
  ];
  for (const scenario of cases) {
    const phase: LoadPhase = new LoadPhase("failure-diagnostics", 1);
    let fetchCalls: number = 0;
    let waits: number = 0;
    const runtime: LoadHttpRuntime = {
      now: (): number => fetchCalls * 17,
      wait: async (): Promise<void> => {
        waits += 1;
      },
      fetch: async (): Promise<Response> => {
        fetchCalls += 1;
        if (scenario.stage === "fetch") return await Promise.reject(scenario.error);
        if (scenario.stage === "body-read") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                controller.error(scenario.error);
              },
            }),
            { status: scenario.status },
          );
        }
        return new Response(secret, { status: scenario.status });
      },
    };
    const client: LoadHttpClient = new LoadHttpClient(
      new URL("http://127.0.0.1:1/mcp"),
      phase,
      new AbortController().signal,
      runtime,
    );
    let failure: unknown = null;
    try {
      await request(client);
    } catch (error: unknown) {
      failure = error;
    }
    if (!(failure instanceof Error)) throw new Error("Expected classified load failure");
    expect(failure.message).toBe(
      `Load HTTP request failed (stage=${scenario.stage}, label=${scenario.label}, status=${scenario.status})`,
    );
    const report: PhaseReport = phase.report();
    expect(report.statusCodes).toEqual({ [String(scenario.status)]: 1 });
    expect(report.httpAttempts).toBe(1);
    expect(report.attemptP95Ms).toBe(17);
    expect(report.operations).toBe(0);
    expect(report.retries).toBe(0);
    expect(report.mcpCapacityResponses).toBe(0);
    expect(fetchCalls).toBe(1);
    expect(waits).toBe(0);
    expect(JSON.stringify({ failure: failure.message, report })).not.toContain(secret);
  }
});
