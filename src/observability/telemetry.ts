import {
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import packageMetadata from "../../package.json" with { type: "json" };
import { HEALTH_PATH } from "../http/http-config.js";
import { redactSensitiveText } from "../redaction.js";
import { settleWithin } from "./deadline.js";
import type { LogFields, LogValue } from "./structured-logger.js";

export type RequestTrace = {
  readonly spanId: string | null;
  readonly traceId: string | null;
  finish(fields: LogFields, failed: boolean): void;
};

export type Telemetry = {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
  startRequest(request: Request, requestId: string, route: string): RequestTrace;
};

export type TelemetryConfiguration = {
  readonly enabled: boolean;
  readonly exportTimeoutMillis: number;
  readonly exporterUrl: string | null;
};

const DEFAULT_EXPORT_TIMEOUT_MS: number = 4_000;
const MIN_EXPORT_TIMEOUT_MS: number = 100;
const MAX_EXPORT_TIMEOUT_MS: number = 5_000;

export class MissingTelemetryEndpointError extends Error {
  public constructor() {
    super(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT is required when telemetry is enabled",
    );
    this.name = "MissingTelemetryEndpointError";
  }
}

export class UnsupportedTelemetryProtocolError extends Error {
  public constructor() {
    super("Murmur tracing supports only OTLP http/protobuf export");
    this.name = "UnsupportedTelemetryProtocolError";
  }
}

export class InvalidTelemetryEndpointError extends Error {
  public constructor() {
    super("The OTLP endpoint must be a valid absolute URL");
    this.name = "InvalidTelemetryEndpointError";
  }
}

export class InsecureTelemetryEndpointError extends Error {
  public constructor() {
    super("The OTLP endpoint must use HTTPS, except for localhost development");
    this.name = "InsecureTelemetryEndpointError";
  }
}

export class InvalidTelemetryEnabledError extends Error {
  public constructor() {
    super("MURMUR_TELEMETRY_ENABLED must be '0' or '1'");
    this.name = "InvalidTelemetryEnabledError";
  }
}

export class InvalidTelemetryTimeoutError extends Error {
  public constructor() {
    super("MURMUR_TELEMETRY_EXPORT_TIMEOUT_MS must be an integer from 100 to 5000");
    this.name = "InvalidTelemetryTimeoutError";
  }
}

class InvalidTelemetryStateError extends Error {
  public constructor() {
    super("Enabled telemetry requires a validated exporter URL");
    this.name = "InvalidTelemetryStateError";
  }
}

function validatedExporterUrl(environment: NodeJS.ProcessEnv): string {
  const traceEndpoint: string | undefined = environment["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  const genericEndpoint: string | undefined = environment["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const configured: string | undefined =
    traceEndpoint === undefined || traceEndpoint.length === 0 ? genericEndpoint : traceEndpoint;
  if (configured === undefined || configured.length === 0) {
    throw new MissingTelemetryEndpointError();
  }
  const protocol: string | undefined = environment["OTEL_EXPORTER_OTLP_PROTOCOL"];
  if (protocol !== undefined && protocol.length > 0 && protocol !== "http/protobuf") {
    throw new UnsupportedTelemetryProtocolError();
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch (_error: unknown) {
    throw new InvalidTelemetryEndpointError();
  }
  const local: boolean = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new InsecureTelemetryEndpointError();
  }
  if (traceEndpoint !== undefined && traceEndpoint.length > 0) return url.toString();
  const normalizedPath: string = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${normalizedPath}/v1/traces`;
  return url.toString();
}

export function telemetryConfiguration(environment: NodeJS.ProcessEnv): TelemetryConfiguration {
  const enabledValue: string | undefined = environment["MURMUR_TELEMETRY_ENABLED"];
  if (enabledValue === undefined || enabledValue.length === 0 || enabledValue === "0") {
    return {
      enabled: false,
      exportTimeoutMillis: DEFAULT_EXPORT_TIMEOUT_MS,
      exporterUrl: null,
    };
  }
  if (enabledValue !== "1") throw new InvalidTelemetryEnabledError();
  const configuredTimeout: string | undefined = environment["MURMUR_TELEMETRY_EXPORT_TIMEOUT_MS"];
  const exportTimeoutMillis: number =
    configuredTimeout === undefined || configuredTimeout.length === 0
      ? DEFAULT_EXPORT_TIMEOUT_MS
      : Number(configuredTimeout);
  if (
    !Number.isSafeInteger(exportTimeoutMillis) ||
    exportTimeoutMillis < MIN_EXPORT_TIMEOUT_MS ||
    exportTimeoutMillis > MAX_EXPORT_TIMEOUT_MS
  ) {
    throw new InvalidTelemetryTimeoutError();
  }
  return {
    enabled: true,
    exportTimeoutMillis,
    exporterUrl: validatedExporterUrl(environment),
  };
}

class OpenTelemetryRequestTrace implements RequestTrace {
  public readonly spanId: string | null;
  public readonly traceId: string | null;
  private finished: boolean;
  private readonly span: Span;

  public constructor(span: Span) {
    const spanContext: ReturnType<Span["spanContext"]> = span.spanContext();
    const valid: boolean = isSpanContextValid(spanContext);
    this.finished = false;
    this.span = span;
    this.spanId = valid ? spanContext.spanId : null;
    this.traceId = valid ? spanContext.traceId : null;
  }

  public finish(fields: LogFields, failed: boolean): void {
    if (this.finished) return;
    this.finished = true;
    Object.entries(fields).forEach((entry: [string, LogValue]): void => {
      if (entry[0] === "request_id" || entry[0] === "span_id" || entry[0] === "trace_id") return;
      const value: LogValue =
        typeof entry[1] === "string" ? redactSensitiveText(entry[1]) : entry[1];
      if (value !== null) this.span.setAttribute(`murmur.${entry[0]}`, value);
    });
    const statusCode: LogValue | undefined = fields["http_status_code"];
    if (typeof statusCode === "number") {
      this.span.setAttribute("http.response.status_code", statusCode);
    }
    const errorType: LogValue | undefined = fields["error_class"];
    if (typeof errorType === "string") this.span.setAttribute("error.type", errorType);
    if (failed) this.span.setStatus({ code: SpanStatusCode.ERROR });
    this.span.end();
  }
}

class OpenTelemetry implements Telemetry {
  public readonly enabled: boolean = true;
  private readonly exportTimeoutMillis: number;
  private readonly provider: NodeTracerProvider;
  private readonly tracer: Tracer;

  public constructor(configuration: TelemetryConfiguration, environment: NodeJS.ProcessEnv) {
    const exporterUrl: string | null = configuration.exporterUrl;
    if (!configuration.enabled || exporterUrl === null) {
      throw new InvalidTelemetryStateError();
    }
    this.exportTimeoutMillis = configuration.exportTimeoutMillis;
    const exporter: OTLPTraceExporter = new OTLPTraceExporter({
      timeoutMillis: this.exportTimeoutMillis,
      url: exporterUrl,
    });
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "murmur",
        [ATTR_SERVICE_NAMESPACE]: "agent-coordination",
        [ATTR_SERVICE_VERSION]: packageMetadata.version,
        "deployment.environment.name": environment["MURMUR_ENVIRONMENT"] ?? "development",
      }),
      spanLimits: {
        attributeCountLimit: 64,
        attributeValueLengthLimit: 256,
        eventCountLimit: 8,
        linkCountLimit: 8,
      },
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          exportTimeoutMillis: this.exportTimeoutMillis,
          maxExportBatchSize: 256,
          maxQueueSize: 1_024,
          scheduledDelayMillis: 5_000,
        }),
      ],
    });
    this.provider.register();
    this.tracer = this.provider.getTracer("murmur-http", packageMetadata.version);
  }

  public async shutdown(): Promise<void> {
    await settleWithin(
      this.provider.shutdown(),
      this.exportTimeoutMillis + 250,
      `OpenTelemetry shutdown exceeded ${this.exportTimeoutMillis + 250}ms`,
    );
  }

  public startRequest(request: Request, requestId: string, route: string): RequestTrace {
    if (route === HEALTH_PATH) return DISABLED_TRACE;
    const span: Span = this.tracer.startSpan(`${request.method} ${route}`, {
      attributes: {
        "http.request.method": request.method,
        "http.route": route,
        "murmur.request_id": requestId,
      },
      kind: SpanKind.SERVER,
      root: true,
    });
    return new OpenTelemetryRequestTrace(span);
  }
}

const DISABLED_TRACE: RequestTrace = {
  finish: (_fields: LogFields, _failed: boolean): void => {},
  spanId: null,
  traceId: null,
};

const DISABLED_TELEMETRY: Telemetry = {
  enabled: false,
  shutdown: async (): Promise<void> => {},
  startRequest: (_request: Request, _requestId: string, _route: string): RequestTrace =>
    DISABLED_TRACE,
};

export function createTelemetry(environment: NodeJS.ProcessEnv): Telemetry {
  const configuration: TelemetryConfiguration = telemetryConfiguration(environment);
  return configuration.enabled ? new OpenTelemetry(configuration, environment) : DISABLED_TELEMETRY;
}
