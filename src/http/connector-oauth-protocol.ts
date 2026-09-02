import { jsonResponse } from "./http-request.js";
import {
  MCP_PATH,
  OAUTH_AUTHORIZATION_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_TOKEN_PATH,
} from "./http-config.js";

export const CONNECTOR_CLIENT_ID: string = "murmur";
export const CONNECTOR_SCOPE: string = "murmur";
const OAUTH_RATE_WINDOW_MS: number = 60_000;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set<string>([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

export function issuerForRequest(request: Request, publicOrigin: string | null): string | null {
  if (publicOrigin !== null) return publicOrigin;
  const url: URL = new URL(request.url);
  return LOOPBACK_HOSTNAMES.has(url.hostname) ? url.origin : null;
}

export function mcpResource(issuer: string): string {
  return new URL(MCP_PATH, issuer).href;
}

export function connectorAuthorizationIssueRateLimit(
  authorizationCodeLifetimeMs: number,
  maximumAuthorizationCodes: number,
  configuredRateLimit: number,
): number {
  const liveWindows: number = Math.ceil(authorizationCodeLifetimeMs / OAUTH_RATE_WINDOW_MS) + 1;
  const capacityBound: number = Math.floor((maximumAuthorizationCodes - 1) / liveWindows);
  return Math.min(configuredRateLimit, capacityBound);
}

export function connectorProtectedResourceMetadataUrl(
  request: Request,
  publicOrigin: string | null,
): string | null {
  const issuer: string | null = issuerForRequest(request, publicOrigin);
  return issuer === null ? null : new URL(OAUTH_PROTECTED_RESOURCE_PATH, issuer).href;
}

export function methodNotAllowed(method: string): Response {
  return new Response(null, {
    headers: { allow: method, "cache-control": "no-store" },
    status: 405,
  });
}

export function oauthError(
  status: number,
  error: string,
  description: string,
  authenticate: boolean = false,
): Response {
  const headers: Headers = new Headers({ "cache-control": "no-store" });
  if (authenticate) headers.set("www-authenticate", 'Basic realm="murmur-oauth"');
  return Response.json({ error, error_description: description }, { headers, status });
}

function authorizationRedirect(
  redirectUri: string,
  parameters: Readonly<Record<string, string>>,
  state: string | null,
  issuer: string,
): Response {
  const location: URL = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) location.searchParams.set(name, value);
  if (state !== null) location.searchParams.set("state", state);
  location.searchParams.set("iss", issuer);
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location: location.href,
      "referrer-policy": "no-referrer",
    },
    status: 302,
  });
}

export function appendAuthorizationResult(
  redirectUri: string,
  code: string,
  state: string | null,
  issuer: string,
): Response {
  return authorizationRedirect(redirectUri, { code }, state, issuer);
}

export function appendAuthorizationError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
  issuer: string,
): Response {
  return authorizationRedirect(
    redirectUri,
    { error, error_description: description },
    state,
    issuer,
  );
}

export function oauthRateLimitError(): Response {
  const response: Response = oauthError(
    429,
    "temporarily_unavailable",
    "OAuth request rate limit reached",
  );
  response.headers.set("retry-after", "60");
  return response;
}

export function protectedResourceMetadata(issuer: string): Response {
  return jsonResponse(200, {
    authorization_servers: [issuer],
    resource: mcpResource(issuer),
    resource_documentation: `${issuer}/`,
    resource_name: "Murmur",
    scopes_supported: [CONNECTOR_SCOPE],
  });
}

export function authorizationServerMetadata(issuer: string): Response {
  return jsonResponse(200, {
    authorization_endpoint: `${issuer}${OAUTH_AUTHORIZATION_PATH}`,
    authorization_response_iss_parameter_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
    issuer,
    response_types_supported: ["code"],
    scopes_supported: [CONNECTOR_SCOPE],
    token_endpoint: `${issuer}${OAUTH_TOKEN_PATH}`,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  });
}
