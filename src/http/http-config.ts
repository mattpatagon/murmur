import { z } from "zod";

import packageMetadata from "../../package.json" with { type: "json" };
import {
  type MurmurReleaseMetadata,
  MurmurReleaseMetadataSchema,
} from "../domain/upgrade-contracts.js";

export const HEALTH_PATH: string = "/health";
export const MCP_PATH: string = "/mcp";
export const RELEASE_PATH: string = "/version";
export const TENANT_REGISTRATION_PATH: string = "/v1/tenants";
export const SSE_KEEP_ALIVE_MS: number = 1_000;

export type HttpServerConfig = {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly authenticationWaitMs: number;
  readonly hostname: string;
  readonly maxActiveRequests: number;
  readonly maxActiveRequestsPerPrincipal: number;
  readonly maxActiveRequestsPerTenant: number;
  readonly maxActiveStreams: number;
  readonly maxActiveStreamsPerPrincipal: number;
  readonly maxActiveStreamsPerTenant: number;
  readonly maxAuthentications: number;
  readonly maxPendingAuthentications: number;
  readonly maxPendingAuthenticationsPerTenant: number;
  readonly maxRequestBytes: number;
  readonly maxSessions: number;
  readonly maxSessionsPerTenant: number;
  readonly rateLimitPerMinute: number;
  readonly releaseMetadata: MurmurReleaseMetadata | null;
  readonly registrationRateLimitPerMinute: number;
  readonly requestedPort: number;
  readonly sessionIdleMs: number;
  readonly tenantRateLimitPerMinute: number;
};

type HttpDefaults = Omit<
  HttpServerConfig,
  "allowedOrigins" | "hostname" | "releaseMetadata" | "requestedPort"
> & {
  readonly port: number;
};

const DEFAULTS: HttpDefaults = {
  authenticationWaitMs: 2_000,
  maxActiveRequests: 64,
  maxActiveRequestsPerPrincipal: 8,
  maxActiveRequestsPerTenant: 20,
  maxActiveStreams: 64,
  maxActiveStreamsPerPrincipal: 32,
  maxActiveStreamsPerTenant: 32,
  maxAuthentications: 4,
  maxPendingAuthentications: 32,
  maxPendingAuthenticationsPerTenant: 8,
  maxRequestBytes: 1_048_576,
  maxSessions: 1_000,
  maxSessionsPerTenant: 100,
  port: 8080,
  rateLimitPerMinute: 600,
  registrationRateLimitPerMinute: 10,
  sessionIdleMs: 15 * 60 * 1_000,
  tenantRateLimitPerMinute: 3_000,
};

function parsePort(environment: NodeJS.ProcessEnv): number {
  const configured: string | undefined = environment["PORT"];
  if (configured === undefined || configured === "") return DEFAULTS.port;
  return z.coerce.number().int().min(0).max(65_535).parse(configured);
}

function positiveIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const configured: string | undefined = environment[name];
  return configured === undefined || configured === ""
    ? fallback
    : z.coerce.number().int().positive().safe().parse(configured);
}

function parseAllowedOrigins(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const configured: string | undefined = environment["MURMUR_ALLOWED_ORIGINS"];
  if (configured === undefined || configured.trim() === "") return new Set<string>();
  const origins: string[] = configured
    .split(",")
    .map((origin: string): string => origin.trim())
    .filter((origin: string): boolean => origin !== "");
  return new Set<string>(origins);
}

function parseReleaseMetadata(environment: NodeJS.ProcessEnv): MurmurReleaseMetadata | null {
  const revision: string | undefined = environment["MURMUR_RELEASE_REVISION"];
  if (revision === undefined || revision === "") return null;
  return MurmurReleaseMetadataSchema.parse({ revision, version: packageMetadata.version });
}

export function parseHttpServerConfig(environment: NodeJS.ProcessEnv): HttpServerConfig {
  return {
    allowedOrigins: parseAllowedOrigins(environment),
    authenticationWaitMs: positiveIntegerEnvironment(
      environment,
      "MURMUR_AUTHENTICATION_WAIT_MS",
      DEFAULTS.authenticationWaitMs,
    ),
    hostname: environment["MURMUR_HTTP_HOST"] ?? "0.0.0.0",
    maxActiveRequests: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_ACTIVE_REQUESTS",
      DEFAULTS.maxActiveRequests,
    ),
    maxActiveRequestsPerPrincipal: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL",
      DEFAULTS.maxActiveRequestsPerPrincipal,
    ),
    maxActiveRequestsPerTenant: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT",
      DEFAULTS.maxActiveRequestsPerTenant,
    ),
    maxActiveStreams: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_ACTIVE_STREAMS",
      DEFAULTS.maxActiveStreams,
    ),
    maxActiveStreamsPerPrincipal: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL",
      DEFAULTS.maxActiveStreamsPerPrincipal,
    ),
    maxActiveStreamsPerTenant: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT",
      DEFAULTS.maxActiveStreamsPerTenant,
    ),
    maxAuthentications: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_CONCURRENT_AUTHENTICATIONS",
      DEFAULTS.maxAuthentications,
    ),
    maxPendingAuthentications: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_PENDING_AUTHENTICATIONS",
      DEFAULTS.maxPendingAuthentications,
    ),
    maxPendingAuthenticationsPerTenant: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT",
      DEFAULTS.maxPendingAuthenticationsPerTenant,
    ),
    maxRequestBytes: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_REQUEST_BYTES",
      DEFAULTS.maxRequestBytes,
    ),
    maxSessions: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_SESSIONS",
      DEFAULTS.maxSessions,
    ),
    maxSessionsPerTenant: positiveIntegerEnvironment(
      environment,
      "MURMUR_MAX_SESSIONS_PER_TENANT",
      DEFAULTS.maxSessionsPerTenant,
    ),
    rateLimitPerMinute: positiveIntegerEnvironment(
      environment,
      "MURMUR_RATE_LIMIT_PER_MINUTE",
      DEFAULTS.rateLimitPerMinute,
    ),
    releaseMetadata: parseReleaseMetadata(environment),
    registrationRateLimitPerMinute: positiveIntegerEnvironment(
      environment,
      "MURMUR_REGISTRATION_RATE_LIMIT_PER_MINUTE",
      DEFAULTS.registrationRateLimitPerMinute,
    ),
    requestedPort: parsePort(environment),
    sessionIdleMs: positiveIntegerEnvironment(
      environment,
      "MURMUR_SESSION_IDLE_MS",
      DEFAULTS.sessionIdleMs,
    ),
    tenantRateLimitPerMinute: positiveIntegerEnvironment(
      environment,
      "MURMUR_TENANT_RATE_LIMIT_PER_MINUTE",
      DEFAULTS.tenantRateLimitPerMinute,
    ),
  };
}
