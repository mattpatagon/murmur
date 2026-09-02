import { z } from "zod";

import packageMetadata from "../../package.json" with { type: "json" };
import {
  type MurmurReleaseMetadata,
  MurmurReleaseMetadataSchema,
} from "../domain/upgrade-contracts.js";

export const HEALTH_PATH: string = "/health";
export const MCP_PATH: string = "/mcp";
export const OAUTH_AUTHORIZATION_PATH: string = "/oauth/authorize";
export const OAUTH_PROTECTED_RESOURCE_PATH: string = `/.well-known/oauth-protected-resource${MCP_PATH}`;
export const OAUTH_PROTECTED_RESOURCE_ROOT_PATH: string = "/.well-known/oauth-protected-resource";
export const OAUTH_SERVER_METADATA_PATH: string = "/.well-known/oauth-authorization-server";
export const OAUTH_TOKEN_PATH: string = "/oauth/token";
export const RELEASE_PATH: string = "/version";
export const TENANT_REGISTRATION_PATH: string = "/v1/tenants";
export const SSE_KEEP_ALIVE_MS: number = 1_000;
const MAXIMUM_STREAM_LIFETIME_MS: number = 55 * 60 * 1_000;
const CHATGPT_REDIRECT_URI: string = "https://chatgpt.com/connector_platform_oauth_redirect";
const GROK_REDIRECT_URI: string = "https://grok.com/oauth/callback";

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
  readonly maxStreamLifetimeMs: number;
  readonly maxAuthentications: number;
  readonly maxPendingAuthentications: number;
  readonly maxPendingAuthenticationsPerTenant: number;
  readonly maxRequestBytes: number;
  readonly maxSessions: number;
  readonly maxSessionsPerTenant: number;
  readonly oauthAllowedRedirectUris: ReadonlySet<string>;
  readonly oauthAuthorizationCodeLifetimeMs: number;
  readonly oauthAuthorizationRateLimitPerMinute: number;
  readonly oauthMaxAuthorizationCodes: number;
  readonly oauthPublicOrigin: string | null;
  readonly rateLimitPerMinute: number;
  readonly releaseMetadata: MurmurReleaseMetadata | null;
  readonly registrationRateLimitPerMinute: number;
  readonly requestedPort: number;
  readonly sessionIdleMs: number;
  readonly tenantRateLimitPerMinute: number;
};

type HttpDefaults = Omit<
  HttpServerConfig,
  | "allowedOrigins"
  | "hostname"
  | "oauthAllowedRedirectUris"
  | "releaseMetadata"
  | "requestedPort"
  | "oauthPublicOrigin"
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
  maxStreamLifetimeMs: MAXIMUM_STREAM_LIFETIME_MS,
  maxAuthentications: 4,
  maxPendingAuthentications: 32,
  maxPendingAuthenticationsPerTenant: 8,
  maxRequestBytes: 1_048_576,
  maxSessions: 1_000,
  maxSessionsPerTenant: 100,
  oauthAuthorizationCodeLifetimeMs: 5 * 60 * 1_000,
  oauthAuthorizationRateLimitPerMinute: 30,
  oauthMaxAuthorizationCodes: 256,
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

function boundedPositiveIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const configured: string | undefined = environment[name];
  return configured === undefined || configured === ""
    ? fallback
    : z.coerce.number().int().positive().max(maximum).safe().parse(configured);
}

function streamLifetimeEnvironment(environment: NodeJS.ProcessEnv): number {
  const configured: string | undefined = environment["MURMUR_MAX_STREAM_LIFETIME_MS"];
  return configured === undefined || configured === ""
    ? DEFAULTS.maxStreamLifetimeMs
    : z.coerce.number().int().positive().max(MAXIMUM_STREAM_LIFETIME_MS).safe().parse(configured);
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

function oauthRedirectUri(value: string): string {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch (_error: unknown) {
    throw new Error("MURMUR_OAUTH_ALLOWED_REDIRECT_URIS must contain absolute HTTPS URLs");
  }
  if (
    redirect.protocol !== "https:" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.search !== "" ||
    redirect.hash !== ""
  ) {
    throw new Error("MURMUR_OAUTH_ALLOWED_REDIRECT_URIS must contain absolute HTTPS URLs");
  }
  return redirect.href;
}

function parseOauthRedirectUris(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const configured: string | undefined = environment["MURMUR_OAUTH_ALLOWED_REDIRECT_URIS"];
  const defaults: string[] = [CHATGPT_REDIRECT_URI, GROK_REDIRECT_URI];
  if (configured === undefined || configured.trim() === "") return new Set<string>(defaults);
  if (configured.length > 16_384) {
    throw new Error("MURMUR_OAUTH_ALLOWED_REDIRECT_URIS exceeds its configuration limit");
  }
  const additional: string[] = configured
    .split(",")
    .map((value: string): string => value.trim())
    .filter((value: string): boolean => value !== "")
    .map(oauthRedirectUri);
  if (additional.length > 32) {
    throw new Error("MURMUR_OAUTH_ALLOWED_REDIRECT_URIS allows at most 32 additional URLs");
  }
  return new Set<string>([...defaults, ...additional]);
}

function parseOauthPublicOrigin(environment: NodeJS.ProcessEnv): string | null {
  const configured: string | undefined = environment["MURMUR_PUBLIC_ORIGIN"];
  if (configured === undefined || configured.trim() === "") return null;
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch (_error: unknown) {
    throw new Error("MURMUR_PUBLIC_ORIGIN must be an absolute HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== configured
  ) {
    throw new Error("MURMUR_PUBLIC_ORIGIN must be an absolute HTTPS origin");
  }
  return origin.origin;
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
    maxStreamLifetimeMs: streamLifetimeEnvironment(environment),
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
    oauthAllowedRedirectUris: parseOauthRedirectUris(environment),
    oauthAuthorizationCodeLifetimeMs: boundedPositiveIntegerEnvironment(
      environment,
      "MURMUR_OAUTH_AUTHORIZATION_CODE_LIFETIME_MS",
      DEFAULTS.oauthAuthorizationCodeLifetimeMs,
      10 * 60 * 1_000,
    ),
    oauthAuthorizationRateLimitPerMinute: positiveIntegerEnvironment(
      environment,
      "MURMUR_OAUTH_AUTHORIZATION_RATE_LIMIT_PER_MINUTE",
      DEFAULTS.oauthAuthorizationRateLimitPerMinute,
    ),
    oauthMaxAuthorizationCodes: boundedPositiveIntegerEnvironment(
      environment,
      "MURMUR_OAUTH_MAX_AUTHORIZATION_CODES",
      DEFAULTS.oauthMaxAuthorizationCodes,
      4_096,
    ),
    oauthPublicOrigin: parseOauthPublicOrigin(environment),
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
