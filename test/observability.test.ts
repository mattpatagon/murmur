import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TenantId } from "../src/domain/value-objects.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { mcpRequestMetadata, type McpRequestMetadata } from "../src/http/http-request.js";
import { createHttpRequestHandler } from "../src/http/http-router.js";
import {
  createHttpObservability,
  type ObservationClock,
  RequestObservation,
} from "../src/observability/request-observation.js";
import {
  type LogFields,
  type LogOutput,
  StructuredLogger,
} from "../src/observability/structured-logger.js";
import {
  createTelemetry,
  type RequestTrace,
  type Telemetry,
} from "../src/observability/telemetry.js";
import {
  initializeSession,
  postJson,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

class CapturingOutput implements LogOutput {
  public readonly errors: string[] = [];
  public readonly infos: string[] = [];

  public error(line: string): void {
    this.errors.push(line);
  }

  public info(line: string): void {
    this.infos.push(line);
  }
}

class CapturingTrace implements RequestTrace {
  public readonly spanId: string | null = "span-123";
  public readonly traceId: string | null = "trace-123";
  public failed: boolean | null = null;
  public fields: LogFields | null = null;
  public finishes: number = 0;

  public finish(fields: LogFields, failed: boolean): void {
    this.failed = failed;
    this.fields = fields;
    this.finishes += 1;
  }
}

class CapturingTelemetry implements Telemetry {
  public readonly enabled: boolean = true;
  public readonly trace: CapturingTrace = new CapturingTrace();
  public shutdowns: number = 0;

  public async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }

  public startRequest(_request: Request, _requestId: string, _route: string): RequestTrace {
    return this.trace;
  }
}

class FailingTelemetry implements Telemetry {
  public readonly enabled: boolean = true;
  public readonly trace: CapturingTrace = new CapturingTrace();

  public async shutdown(): Promise<void> {
    throw new Error("COLLECTOR_FAILURE_SENTINEL");
  }

  public startRequest(_request: Request, _requestId: string, _route: string): RequestTrace {
    return this.trace;
  }
}

class SequenceClock implements ObservationClock {
  private readonly values: number[];

  public constructor(values: readonly number[]) {
    this.values = Array.from(values);
  }

  public now(): number {
    const value: number | undefined = this.values.shift();
    if (value === undefined) throw new Error("The observation clock is exhausted");
    return value;
  }
}

function loggerEnvironment(): NodeJS.ProcessEnv {
  return {
    GITHUB_SHA: "abc123",
    HOSTNAME: "instance-7",
    MURMUR_ENVIRONMENT: "test",
    MURMUR_REGION: "test-region",
  };
}

test("structured logger emits one-line JSON with deployment context", (): void => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  logger.info("service.ready", { port: 3000 });

  expect(output.errors).toHaveLength(0);
  expect(output.infos).toHaveLength(1);
  const line: string | undefined = output.infos[0];
  if (line === undefined) throw new Error("The structured log line is missing");
  expect(line).not.toContain("\n");
  const record: unknown = JSON.parse(line);
  expect(record).toMatchObject({
    commit_sha: "abc123",
    environment: "test",
    event: "service.ready",
    instance_id: "instance-7",
    port: 3000,
    region: "test-region",
    runtime: "bun",
    service: "murmur",
    severity: "INFO",
  });
});

test("structured logger redacts credentials even when a caller bypasses safe errors", (): void => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  const token: string = `mur_tenant01_${"a".repeat(43)}`;
  logger.error("unsafe.caller", { message: `failed for ${token}` });
  const line: string | undefined = output.errors[0];
  if (line === undefined) throw new Error("The defensive redaction log is missing");
  expect(line).toContain("[redacted-token]");
  expect(line).not.toContain(token);
});

test("structured logger validates its only supported verbosity states", (): void => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger({ MURMUR_LOG_LEVEL: "off" }, output);
  logger.info("disabled.event", {});
  logger.error("disabled.error", {});
  expect(output.infos).toHaveLength(0);
  expect(output.errors).toHaveLength(0);
  expect(
    (): StructuredLogger => new StructuredLogger({ MURMUR_LOG_LEVEL: "debug" }, output),
  ).toThrow("MURMUR_LOG_LEVEL must be 'info' or 'off'");
});

test("MCP request metadata drops arguments before crossing the observation boundary", (): void => {
  const secret: string = "RAW_MESSAGE_BODY_SECRET";
  const metadata: McpRequestMetadata = mcpRequestMetadata({
    method: "tools/call",
    params: { arguments: { content: secret }, name: "send_message" },
  });
  expect(metadata).toEqual({ method: "tools/call", tool: "send_message" });
  expect(JSON.stringify(metadata)).not.toContain(secret);
  expect(mcpRequestMetadata([{ method: "tools/list" }])).toEqual({ method: null, tool: null });
  expect(mcpRequestMetadata({ method: "INVALID METHOD", params: {} })).toEqual({
    method: null,
    tool: null,
  });
});

test("request completion event correlates safely without retaining secrets", async (): Promise<void> => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  const telemetry: CapturingTelemetry = new CapturingTelemetry();
  const clock: SequenceClock = new SequenceClock([1_000, 1_037]);
  const rawSession: string = "RAW_SESSION_SECRET";
  const tokenSecret: string = "mur_agent_RAW_TOKEN_SECRET";
  const request: Request = new Request("https://murmur.example/mcp?secret=RAW_QUERY_SECRET", {
    headers: {
      Authorization: `Bearer ${tokenSecret}`,
      "Mcp-Session-Id": rawSession,
      "X-Request-Id": "request-123",
    },
    method: "POST",
  });
  const observation: RequestObservation = new RequestObservation(request, logger, telemetry, clock);
  const serverRequestId: string = observation.id;
  observation.recordAuthentication("authenticated");
  observation.recordAuthenticationCapacity("allowed");
  observation.recordCredential("known");
  observation.recordRequestCapacity("allowed");
  observation.recordPrincipalRateLimit("allowed");
  observation.recordTenantRateLimit("allowed");
  observation.recordMcpRequest({
    method: "tools/call",
    tool: "send_message",
  });
  observation.recordOrigin("allowed");
  observation.recordPrincipal({
    kind: "tenant",
    role: "agent",
    tenantId: TenantId.parse("42000000-0000-4000-8000-000000000001"),
    tokenId: tokenSecret,
  });
  observation.recordSession(rawSession);
  observation.recordSessionCapacity("allowed", "global_and_tenant");
  observation.recordSessionLookup("found");
  observation.recordError(
    new Error("database failed at postgresql://murmur:RAW_DATABASE_SECRET@database.example/murmur"),
  );

  const tracked: Response = observation.track(new Response("ok", { status: 200 }));
  expect(tracked.headers.get("x-request-id")).toBe(serverRequestId);
  expect(serverRequestId).not.toBe("request-123");
  expect(await tracked.text()).toBe("ok");

  expect(output.infos).toHaveLength(1);
  expect(output.errors).toHaveLength(0);
  expect(telemetry.trace.finishes).toBe(1);
  expect(telemetry.trace.failed).toBe(false);
  const line: string | undefined = output.infos[0];
  if (line === undefined) throw new Error("The request completion log is missing");
  expect(line).toContain('"event":"http.request.completed"');
  expect(line).toContain('"duration_ms":37');
  expect(line).toContain('"credential":"known"');
  expect(line).toContain('"mcp_method":"tools/call"');
  expect(line).toContain('"mcp_tool":"send_message"');
  expect(line).toContain('"client_request_id":"request-123"');
  expect(line).toContain(`"request_id":"${serverRequestId}"`);
  expect(line).toContain('"session_capacity":"allowed"');
  expect(line).toContain('"session_lookup":"found"');
  expect(line).toContain('"trace_id":"trace-123"');
  expect(line).not.toContain(rawSession);
  expect(line).not.toContain(tokenSecret);
  expect(line).not.toContain("RAW_DATABASE_SECRET");
  expect(line).not.toContain("RAW_QUERY_SECRET");
});

test("stream cancellation completes observation and telemetry shutdown exactly once", async (): Promise<void> => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  const telemetry: CapturingTelemetry = new CapturingTelemetry();
  const clock: SequenceClock = new SequenceClock([2_000, 2_005]);
  const observability: ReturnType<typeof createHttpObservability> = createHttpObservability(
    logger,
    telemetry,
    clock,
  );
  const request: Request = new Request("https://murmur.example/health");
  const observation: RequestObservation = observability.observe(request);
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start: (_controller: ReadableStreamDefaultController<Uint8Array>): void => {},
  });
  const tracked: Response = observation.track(new Response(source));
  if (tracked.body === null) throw new Error("The tracked stream body is missing");
  await tracked.body.cancel("client disconnected");
  await tracked.body.cancel("duplicate cancellation");
  await observability.shutdown();

  expect(output.infos).toHaveLength(1);
  expect(telemetry.trace.finishes).toBe(1);
  expect(telemetry.shutdowns).toBe(1);
});

test("telemetry flush failure is logged safely without failing graceful shutdown", async (): Promise<void> => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  const observability: ReturnType<typeof createHttpObservability> = createHttpObservability(
    logger,
    new FailingTelemetry(),
  );

  await expect(observability.shutdown()).resolves.toBeUndefined();
  expect(output.errors).toHaveLength(1);
  expect(output.errors[0]).toContain('"event":"telemetry.shutdown.failed"');
  expect(output.errors[0]).toContain('"error_class":"Error"');
  expect(output.errors[0]).not.toContain("COLLECTOR_FAILURE_SENTINEL");
});

test("non-tenant principals never populate tenant identity fields", async (): Promise<void> => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  const telemetry: CapturingTelemetry = new CapturingTelemetry();
  const observation: RequestObservation = new RequestObservation(
    new Request("https://murmur.example/mcp", { method: "POST" }),
    logger,
    telemetry,
    new SequenceClock([4_000, 4_001]),
  );
  observation.recordPrincipal({
    credentialHash: Buffer.alloc(32),
    keyId: "operator-key",
    kind: "operator",
    tokenId: "operator-token",
  });
  const response: Response = observation.track(new Response(null));
  await response.arrayBuffer();

  expect(output.infos).toHaveLength(1);
  expect(output.infos[0]).toContain('"principal_kind":"operator"');
  expect(output.infos[0]).toContain('"tenant_id":null');
  expect(output.infos[0]).toContain('"tenant_role":null');
});

test("HTTP router converts handler failures to correlated sanitized responses", async (): Promise<void> => {
  const output: CapturingOutput = new CapturingOutput();
  const logger: StructuredLogger = new StructuredLogger(loggerEnvironment(), output);
  const telemetry: CapturingTelemetry = new CapturingTelemetry();
  const clock: SequenceClock = new SequenceClock([3_000, 3_010]);
  const observability: ReturnType<typeof createHttpObservability> = createHttpObservability(
    logger,
    telemetry,
    clock,
  );
  const sentinel: string = "ROUTER_DATABASE_PASSWORD";
  const originalConsoleError: typeof console.error = console.error;
  const operationalLogs: string[] = [];
  console.error = (...values: unknown[]): void => {
    operationalLogs.push(values.map(String).join(" "));
  };
  try {
    const handler: (request: Request) => Promise<Response> = createHttpRequestHandler(
      observability,
      async (_request: Request, _observation: RequestObservation): Promise<Response> => {
        throw new Error(
          `handler failed at postgresql://murmur:${sentinel}@database.example/murmur`,
        );
      },
    );
    const response: Response = await handler(
      new Request("https://murmur.example/mcp", {
        headers: { "X-Request-Id": "router-request" },
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).not.toBe("router-request");
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  } finally {
    console.error = originalConsoleError;
  }
  expect(output.errors).toHaveLength(1);
  expect(output.errors.join("\n")).not.toContain(sentinel);
  expect(operationalLogs.join("\n")).not.toContain(sentinel);
  expect(telemetry.trace.finishes).toBe(1);
});

test("real HTTP requests never export message, token, session, or query secrets", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-observability-"));
  const bodies: Uint8Array[] = [];
  const collector: Bun.Server<undefined> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      bodies.push(new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const collectorPort: number | undefined = collector.port;
  if (collectorPort === undefined) throw new Error("The integration collector did not bind");
  const environment: NodeJS.ProcessEnv = {
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_LOG_LEVEL: "info",
    MURMUR_TELEMETRY_ENABLED: "1",
    MURMUR_TELEMETRY_EXPORT_TIMEOUT_MS: "1000",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
  };
  const output: CapturingOutput = new CapturingOutput();
  const observability: ReturnType<typeof createHttpObservability> = createHttpObservability(
    new StructuredLogger(environment, output),
    createTelemetry(environment),
  );
  const server: MurmurHttpServer = await startHttpServer(environment, { observability });
  const bodySecret: string = "RAW_HTTP_MESSAGE_SECRET";
  const querySecret: string = "RAW_HTTP_QUERY_SECRET";
  const tokenSecret: string = environment["MURMUR_API_TOKEN"] ?? "";
  try {
    const secretUrl: URL = new URL(server.mcpUrl);
    secretUrl.searchParams.set("secret", querySecret);
    const unauthorized: Response = await fetch(secretUrl, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();
    const forbiddenHeaders: Headers = requestHeaders();
    forbiddenHeaders.set("Origin", "https://untrusted.example");
    const forbidden: Response = await fetch(secretUrl, {
      body: "{}",
      headers: forbiddenHeaders,
      method: "POST",
    });
    expect(forbidden.status).toBe(403);
    await forbidden.arrayBuffer();
    const sessionId: string = await initializeSession(secretUrl);
    const response: Response = await postJson(
      secretUrl,
      {
        id: 77,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            content: bodySecret,
            recipient_id: "missing-recipient",
            sender_id: "missing-sender",
          },
          name: "send_message",
        },
      },
      sessionId,
    );
    expect(response.status).toBe(200);
    await responsePayload(response);
  } finally {
    await server.stop();
    await collector.stop(true);
    rmSync(directory, { force: true, recursive: true });
  }
  const logs: string = [...output.infos, ...output.errors].join("\n");
  const exported: string = bodies
    .map((body: Uint8Array): string => new TextDecoder().decode(body))
    .join("\n");
  [bodySecret, querySecret, tokenSecret].forEach((secret: string): void => {
    expect(logs).not.toContain(secret);
    expect(exported).not.toContain(secret);
  });
  expect(logs).toContain('"authentication":"invalid"');
  expect(logs).toContain('"credential":"missing"');
  expect(logs).toContain('"origin":"rejected"');
  expect(logs).toContain('"mcp_tool":"send_message"');
  expect(bodies.length).toBeGreaterThan(0);
});
