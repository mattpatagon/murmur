import { expect, test } from "bun:test";

import { settleWithin } from "../src/observability/deadline.js";
import {
  createTelemetry,
  InsecureTelemetryEndpointError,
  InvalidTelemetryEnabledError,
  InvalidTelemetryEndpointError,
  InvalidTelemetryTimeoutError,
  MissingTelemetryEndpointError,
  type RequestTrace,
  type Telemetry,
  telemetryConfiguration,
  UnsupportedTelemetryProtocolError,
} from "../src/observability/telemetry.js";

test("telemetry is opt-in and validates bounded HTTP exporter configuration", (): void => {
  expect(telemetryConfiguration({})).toEqual({
    enabled: false,
    exportTimeoutMillis: 4_000,
    exporterUrl: null,
  });
  expect(telemetryConfiguration({ MURMUR_TELEMETRY_ENABLED: "0" })).toEqual({
    enabled: false,
    exportTimeoutMillis: 4_000,
    exporterUrl: null,
  });
  expect(
    telemetryConfiguration({
      MURMUR_TELEMETRY_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://tempo.example/otlp/",
    }),
  ).toEqual({
    enabled: true,
    exportTimeoutMillis: 4_000,
    exporterUrl: "https://tempo.example/otlp/v1/traces",
  });
  expect(
    telemetryConfiguration({
      MURMUR_TELEMETRY_ENABLED: "1",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/custom",
    }),
  ).toEqual({
    enabled: true,
    exportTimeoutMillis: 4_000,
    exporterUrl: "http://localhost:4318/custom",
  });
  expect((): void => {
    telemetryConfiguration({ MURMUR_TELEMETRY_ENABLED: "yes" });
  }).toThrow(InvalidTelemetryEnabledError);
  expect((): void => {
    telemetryConfiguration({ MURMUR_TELEMETRY_ENABLED: "1" });
  }).toThrow(MissingTelemetryEndpointError);
  const endpointSentinel: string = "TELEMETRY_SECRET_SENTINEL";
  try {
    telemetryConfiguration({
      MURMUR_TELEMETRY_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: ["https://user:", endpointSentinel, "@["].join(""),
    });
    throw new Error("Malformed telemetry endpoint unexpectedly parsed");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(InvalidTelemetryEndpointError);
    expect(String(error)).not.toContain(endpointSentinel);
    expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
  }
  expect((): void => {
    telemetryConfiguration({
      MURMUR_TELEMETRY_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo.example",
    });
  }).toThrow(InsecureTelemetryEndpointError);
  expect((): void => {
    telemetryConfiguration({
      MURMUR_TELEMETRY_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://tempo.example",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    });
  }).toThrow(UnsupportedTelemetryProtocolError);
  expect((): void => {
    telemetryConfiguration({
      MURMUR_TELEMETRY_ENABLED: "1",
      MURMUR_TELEMETRY_EXPORT_TIMEOUT_MS: "5001",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://tempo.example",
    });
  }).toThrow(InvalidTelemetryTimeoutError);
});

test("enabled telemetry exports bounded protobuf spans without request secrets", async (): Promise<void> => {
  const bodies: Uint8Array[] = [];
  const paths: string[] = [];
  const contentTypes: string[] = [];
  const collector: Bun.Server<undefined> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      paths.push(new URL(request.url).pathname);
      contentTypes.push(request.headers.get("content-type") ?? "");
      bodies.push(new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const port: number | undefined = collector.port;
  if (port === undefined) throw new Error("The telemetry collector did not bind a port");
  const telemetry: Telemetry = createTelemetry({
    MURMUR_ENVIRONMENT: "test",
    MURMUR_TELEMETRY_ENABLED: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  });
  try {
    const secret: string = "RAW_TRACE_REQUEST_SECRET";
    const request: Request = new Request(`https://murmur.example/mcp?secret=${secret}`, {
      headers: {
        Authorization: `Bearer ${secret}`,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      method: "POST",
    });
    const trace: RequestTrace = telemetry.startRequest(request, "request-export-1", "/mcp");
    const healthTrace: RequestTrace = telemetry.startRequest(request, "health-request", "/health");
    healthTrace.finish({ http_status_code: 200 }, false);
    trace.finish(
      {
        duration_ms: 12,
        http_status_code: 503,
        request_id: "request-export-1",
      },
      true,
    );
    trace.finish({ duration_ms: 999 }, false);
    await telemetry.shutdown();

    expect(telemetry.enabled).toBe(true);
    expect(trace.traceId).toMatch(/^[a-f0-9]{32}$/u);
    // biome-ignore lint/security/noSecrets: This is W3C's public example trace ID, not a credential.
    expect(trace.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(paths).toEqual(["/v1/traces"]);
    expect(contentTypes).toEqual(["application/x-protobuf"]);
    expect(bodies).toHaveLength(1);
    const body: Uint8Array | undefined = bodies[0];
    if (body === undefined) throw new Error("The exported trace payload is missing");
    expect(body.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(body)).not.toContain(secret);
  } finally {
    await collector.stop(true);
  }
});

test("telemetry shutdown stays inside the configured exporter deadline", async (): Promise<void> => {
  const collectorRequest: { release: (() => void) | null } = { release: null };
  const collector: Bun.Server<undefined> = Bun.serve({
    fetch: async (_request: Request): Promise<Response> =>
      await new Promise<Response>((resolve: (response: Response) => void): void => {
        collectorRequest.release = (): void => {
          resolve(new Response(null, { status: 503 }));
        };
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const port: number | undefined = collector.port;
  if (port === undefined) throw new Error("The hanging collector did not bind a port");
  const telemetry: Telemetry = createTelemetry({
    MURMUR_TELEMETRY_ENABLED: "1",
    MURMUR_TELEMETRY_EXPORT_TIMEOUT_MS: "100",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
  });
  const trace: RequestTrace = telemetry.startRequest(
    new Request("https://murmur.example/mcp"),
    "deadline-request",
    "/mcp",
  );
  trace.finish({ http_status_code: 200 }, false);
  const startedAt: number = performance.now();
  try {
    await expect(telemetry.shutdown()).rejects.toThrow("Timeout");
  } finally {
    const releaseRequest: (() => void) | null = collectorRequest.release;
    if (releaseRequest !== null) releaseRequest();
    await collector.stop(true);
  }
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("deadline wrapper resolves, forwards rejection, and rejects stalled operations", async (): Promise<void> => {
  await settleWithin(Promise.resolve(), 100, "should not time out");
  const failure: Error = new Error("operation failed");
  await expect(settleWithin(Promise.reject(failure), 100, "should not time out")).rejects.toBe(
    failure,
  );
  const startedAt: number = performance.now();
  await expect(
    settleWithin(new Promise<void>((_resolve: () => void): void => {}), 10, "deadline exceeded"),
  ).rejects.toThrow("deadline exceeded");
  expect(performance.now() - startedAt).toBeLessThan(500);
});
