import { createHash, randomUUID } from "node:crypto";

import type { HostedPrincipal } from "../hosted/control-plane.js";
import {
  HEALTH_PATH,
  MCP_PATH,
  OAUTH_AUTHORIZATION_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_PROTECTED_RESOURCE_ROOT_PATH,
  OAUTH_SERVER_METADATA_PATH,
  OAUTH_TOKEN_PATH,
  PUBLIC_SETUP_PATH,
  RELEASE_PATH,
  TENANT_REGISTRATION_PATH,
} from "../http/http-config.js";
import type { McpRequestMetadata } from "../http/http-request.js";
import { isPublicDistributionPath } from "../http/public-distribution.js";
import { type ResponseFinishReason, responseWithFinish } from "../http/response-lifecycle.js";
import { type LogFields, StructuredLogger } from "./structured-logger.js";
import { createTelemetry, type RequestTrace, type Telemetry } from "./telemetry.js";

export type ObservationClock = { now(): number };
export type GateOutcome = "allowed" | "not_checked" | "rejected";
export type AuthenticationOutcome = "authenticated" | "backend_error" | "invalid" | "not_checked";
export type CredentialOutcome = "known" | "missing" | "not_checked" | "unknown";
export type SessionLookupOutcome = "found" | "not_checked" | "not_found";

export type HttpObservability = {
  info(event: string, fields: LogFields): void;
  observe(request: Request): RequestObservation;
  shutdown(): Promise<void>;
};

const SYSTEM_OBSERVATION_CLOCK: ObservationClock = { now: (): number => Date.now() };
const SAFE_REQUEST_ID: RegExp = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_ERROR_CLASS: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;

function clientRequestId(request: Request): string | null {
  const supplied: string | null = request.headers.get("x-request-id");
  return supplied !== null && SAFE_REQUEST_ID.test(supplied) ? supplied : null;
}

function routeForRequest(request: Request): string {
  try {
    const pathname: string = new URL(request.url).pathname;
    if (pathname === "/" || pathname === HEALTH_PATH) return HEALTH_PATH;
    if (pathname === MCP_PATH) return MCP_PATH;
    if (pathname === PUBLIC_SETUP_PATH) return PUBLIC_SETUP_PATH;
    if (pathname === OAUTH_AUTHORIZATION_PATH) return OAUTH_AUTHORIZATION_PATH;
    if (pathname === OAUTH_TOKEN_PATH) return OAUTH_TOKEN_PATH;
    if (pathname === OAUTH_SERVER_METADATA_PATH) return OAUTH_SERVER_METADATA_PATH;
    if (pathname === OAUTH_PROTECTED_RESOURCE_PATH) return OAUTH_PROTECTED_RESOURCE_PATH;
    if (pathname === OAUTH_PROTECTED_RESOURCE_ROOT_PATH) {
      return OAUTH_PROTECTED_RESOURCE_ROOT_PATH;
    }
    if (pathname === RELEASE_PATH) return RELEASE_PATH;
    if (isPublicDistributionPath(pathname)) return "/downloads";
    if (pathname === TENANT_REGISTRATION_PATH) return TENANT_REGISTRATION_PATH;
    return "/not-found";
  } catch (_error: unknown) {
    return "/invalid-url";
  }
}

function errorClass(error: unknown): string {
  const candidate: string = error instanceof Error ? error.constructor.name : typeof error;
  return SAFE_ERROR_CLASS.test(candidate) ? candidate : "Error";
}

export class RequestObservation {
  public readonly id: string;
  private authentication: AuthenticationOutcome;
  private authenticationCapacity: GateOutcome;
  private readonly clientRequestId: string | null;
  private credential: CredentialOutcome;
  private errorType: string | null;
  private finished: boolean;
  private readonly logger: StructuredLogger;
  private mcpMethod: string | null;
  private mcpTool: string | null;
  private origin: GateOutcome;
  private principalKind: string | null;
  private principalRateLimit: GateOutcome;
  private readonly request: Request;
  private requestCapacity: GateOutcome;
  private readonly route: string;
  private sessionCapacity: GateOutcome;
  private sessionCapacityScope: string | null;
  private sessionHash: string | null;
  private sessionLookup: SessionLookupOutcome;
  private readonly startedAt: number;
  private streamCapacity: GateOutcome;
  private streamRotated: boolean;
  private tenantId: string | null;
  private tenantRateLimit: GateOutcome;
  private tenantRole: string | null;
  private readonly time: ObservationClock;
  private readonly trace: RequestTrace;

  public constructor(
    request: Request,
    logger: StructuredLogger,
    telemetry: Telemetry,
    time: ObservationClock = SYSTEM_OBSERVATION_CLOCK,
  ) {
    this.authentication = "not_checked";
    this.authenticationCapacity = "not_checked";
    this.clientRequestId = clientRequestId(request);
    this.credential = "not_checked";
    this.errorType = null;
    this.finished = false;
    this.id = randomUUID();
    this.logger = logger;
    this.mcpMethod = null;
    this.mcpTool = null;
    this.origin = "not_checked";
    this.principalKind = null;
    this.principalRateLimit = "not_checked";
    this.request = request;
    this.requestCapacity = "not_checked";
    this.route = routeForRequest(request);
    this.sessionCapacity = "not_checked";
    this.sessionCapacityScope = null;
    this.sessionHash = null;
    this.sessionLookup = "not_checked";
    this.startedAt = time.now();
    this.streamCapacity = "not_checked";
    this.streamRotated = false;
    this.tenantId = null;
    this.tenantRateLimit = "not_checked";
    this.tenantRole = null;
    this.time = time;
    this.trace = telemetry.startRequest(request, this.id, this.route);
  }

  public recordAuthentication(outcome: AuthenticationOutcome): void {
    this.authentication = outcome;
  }

  public recordAuthenticationCapacity(outcome: GateOutcome): void {
    this.authenticationCapacity = outcome;
  }

  public recordError(error: unknown): void {
    this.errorType = errorClass(error);
  }

  public recordCredential(outcome: CredentialOutcome): void {
    this.credential = outcome;
  }

  public recordMcpRequest(metadata: McpRequestMetadata): void {
    this.mcpMethod = metadata.method;
    this.mcpTool = metadata.tool;
  }

  public recordOrigin(outcome: GateOutcome): void {
    this.origin = outcome;
  }

  public recordPrincipal(principal: HostedPrincipal): void {
    this.principalKind = principal.kind;
    if (principal.kind === "tenant") {
      this.tenantId = principal.tenantId.value;
      this.tenantRole = principal.role;
    } else {
      this.tenantRole = null;
    }
  }

  public recordPrincipalRateLimit(outcome: GateOutcome): void {
    this.principalRateLimit = outcome;
  }

  public recordRequestCapacity(outcome: GateOutcome): void {
    this.requestCapacity = outcome;
  }

  public recordSession(sessionId: string): void {
    this.sessionHash = createHash("sha256").update(sessionId).digest("base64url").slice(0, 22);
  }

  public recordSessionCapacity(outcome: GateOutcome, scope: string | null): void {
    this.sessionCapacity = outcome;
    this.sessionCapacityScope = scope;
  }

  public recordSessionLookup(outcome: SessionLookupOutcome): void {
    this.sessionLookup = outcome;
  }

  public recordStreamCapacity(outcome: GateOutcome): void {
    this.streamCapacity = outcome;
  }

  public recordStreamRotation(): void {
    this.streamRotated = true;
  }

  public recordTenantRateLimit(outcome: GateOutcome): void {
    this.tenantRateLimit = outcome;
  }

  private finish(status: number, responseFinish: ResponseFinishReason): void {
    if (this.finished) return;
    this.finished = true;
    const failed: boolean = status >= 500 || responseFinish === "failed";
    const fields: LogFields = {
      authentication: this.authentication,
      authentication_capacity: this.authenticationCapacity,
      client_request_id: this.clientRequestId,
      credential: this.credential,
      duration_ms: Math.max(0, this.time.now() - this.startedAt),
      error_class: this.errorType,
      http_method: this.request.method,
      http_route: this.route,
      http_status_code: status,
      mcp_method: this.mcpMethod,
      mcp_tool: this.mcpTool,
      origin: this.origin,
      outcome:
        responseFinish === "failed"
          ? "stream_error"
          : failed
            ? "server_error"
            : status >= 400
              ? "client_error"
              : "success",
      principal_kind: this.principalKind,
      principal_rate_limit: this.principalRateLimit,
      request_capacity: this.requestCapacity,
      request_id: this.id,
      response_finish: responseFinish,
      session_capacity: this.sessionCapacity,
      session_capacity_scope: this.sessionCapacityScope,
      session_hash: this.sessionHash,
      session_lookup: this.sessionLookup,
      span_id: this.trace.spanId,
      stream_capacity: this.streamCapacity,
      stream_rotated: this.streamRotated,
      tenant_id: this.tenantId,
      tenant_rate_limit: this.tenantRateLimit,
      tenant_role: this.tenantRole,
      trace_id: this.trace.traceId,
    };
    this.trace.finish(fields, failed);
    if (failed) this.logger.error("http.request.completed", fields);
    else this.logger.info("http.request.completed", fields);
  }

  public track(response: Response): Response {
    const headers: Headers = new Headers(response.headers);
    headers.set("x-request-id", this.id);
    const correlated: Response = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
    return responseWithFinish(correlated, (reason: ResponseFinishReason): void => {
      this.finish(response.status, reason);
    });
  }
}

export function createHttpObservability(
  logger: StructuredLogger,
  telemetry: Telemetry,
  time: ObservationClock = SYSTEM_OBSERVATION_CLOCK,
): HttpObservability {
  return {
    info: (event: string, fields: LogFields): void => {
      logger.info(event, fields);
    },
    observe: (request: Request): RequestObservation =>
      new RequestObservation(request, logger, telemetry, time),
    shutdown: async (): Promise<void> => {
      try {
        await telemetry.shutdown();
      } catch (error: unknown) {
        logger.error("telemetry.shutdown.failed", { error_class: errorClass(error) });
      }
    },
  };
}

export function createDefaultHttpObservability(environment: NodeJS.ProcessEnv): HttpObservability {
  return createHttpObservability(new StructuredLogger(environment), createTelemetry(environment));
}
