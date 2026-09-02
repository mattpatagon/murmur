import type { HostedAuthenticator } from "../hosted/authenticator.js";
import type { HostedPrincipal } from "../hosted/control-plane.js";
import type { RequestObservation } from "../observability/request-observation.js";
import type {
  ConnectorAuthorizationCodeStore,
  ConnectorAuthorizationGrant,
} from "./connector-authorization-code-store.js";
import {
  authenticateHostedCredential,
  type HostedAuthenticationResult,
} from "./hosted-credential-authentication.js";
import type { HttpCapacityController } from "./http-capacity.js";
import {
  appendAuthorizationError,
  appendAuthorizationResult,
  authorizationServerMetadata,
  connectorAuthorizationIssueRateLimit,
  CONNECTOR_CLIENT_ID,
  CONNECTOR_SCOPE,
  issuerForRequest,
  mcpResource,
  methodNotAllowed,
  oauthError,
  oauthRateLimitError,
  protectedResourceMetadata,
} from "./connector-oauth-protocol.js";
import {
  OAUTH_AUTHORIZATION_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_PROTECTED_RESOURCE_ROOT_PATH,
  OAUTH_SERVER_METADATA_PATH,
  OAUTH_TOKEN_PATH,
} from "./http-config.js";
import { jsonResponse, RequestBodyTooLargeError, requestBodyBytes } from "./http-request.js";

export { connectorProtectedResourceMetadataUrl } from "./connector-oauth-protocol.js";
const MAXIMUM_FORM_BYTES: number = 8_192;
const MAXIMUM_SECRET_CHARACTERS: number = 2_048;
const CODE_CHALLENGE_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/u;
const CODE_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/u;
const CODE_VERIFIER_PATTERN: RegExp = /^[A-Za-z0-9._~-]{43,128}$/u;

type ConnectorOAuthDependencies = {
  readonly allowedRedirectUris: ReadonlySet<string>;
  readonly authenticator: HostedAuthenticator;
  readonly authorizationCodeLifetimeMs: number;
  readonly authorizationRateLimitPerMinute: number;
  readonly capacity: HttpCapacityController;
  readonly codeStore: ConnectorAuthorizationCodeStore;
  readonly maximumAuthorizationCodes: number;
  readonly publicOrigin: string | null;
  readonly tenantRateLimitPerMinute: number;
};

type ClientCredential = { readonly clientId: string; readonly secret: string };

class InvalidConnectorOAuthRequestError extends Error {
  public constructor() {
    super("The OAuth request is invalid");
    // biome-ignore lint/security/noSecrets: Stable error class identifier, not credential material.
    this.name = "InvalidConnectorOAuthRequestError";
  }
}

function singleParameter(
  parameters: URLSearchParams,
  name: string,
  maximumCharacters: number,
): string | null {
  const values: string[] = parameters.getAll(name);
  if (values.length > 1) throw new InvalidConnectorOAuthRequestError();
  const value: string | undefined = values[0];
  if (value === undefined) return null;
  if (value === "" || value.length > maximumCharacters) {
    throw new InvalidConnectorOAuthRequestError();
  }
  return value;
}

function requiredParameter(
  parameters: URLSearchParams,
  name: string,
  maximumCharacters: number,
): string {
  const value: string | null = singleParameter(parameters, name, maximumCharacters);
  if (value === null) throw new InvalidConnectorOAuthRequestError();
  return value;
}

function exactRedirectUri(value: string, allowed: ReadonlySet<string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_error: unknown) {
    return null;
  }
  return allowed.has(parsed.href) && parsed.href === value ? parsed.href : null;
}

function handleAuthorization(
  request: Request,
  dependencies: ConnectorOAuthDependencies,
  issuer: string,
): Response {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const url: URL = new URL(request.url);
  if (url.search.length > MAXIMUM_FORM_BYTES) {
    return oauthError(400, "invalid_request", "Authorization request is invalid");
  }
  let redirectUri: string | null = null;
  let state: string | null = null;
  try {
    const clientId: string = requiredParameter(url.searchParams, "client_id", 64);
    const redirectValue: string = requiredParameter(url.searchParams, "redirect_uri", 2_048);
    redirectUri = exactRedirectUri(redirectValue, dependencies.allowedRedirectUris);
    if (clientId !== CONNECTOR_CLIENT_ID || redirectUri === null) {
      return oauthError(400, "invalid_request", "Authorization request is invalid");
    }
    state = singleParameter(url.searchParams, "state", 512);
    const responseType: string = requiredParameter(url.searchParams, "response_type", 16);
    if (responseType !== "code") {
      return appendAuthorizationError(
        redirectUri,
        "unsupported_response_type",
        "Authorization response type is unsupported",
        state,
        issuer,
      );
    }
    const scope: string = requiredParameter(url.searchParams, "scope", 128);
    if (scope !== CONNECTOR_SCOPE) {
      return appendAuthorizationError(
        redirectUri,
        "invalid_scope",
        "Authorization scope is invalid",
        state,
        issuer,
      );
    }
    const resource: string = requiredParameter(url.searchParams, "resource", 2_048);
    if (resource !== mcpResource(issuer)) {
      return appendAuthorizationError(
        redirectUri,
        "invalid_target",
        "Authorization resource is invalid",
        state,
        issuer,
      );
    }
    const challenge: string = requiredParameter(url.searchParams, "code_challenge", 128);
    const challengeMethod: string = requiredParameter(
      url.searchParams,
      "code_challenge_method",
      16,
    );
    if (challengeMethod !== "S256" || !CODE_CHALLENGE_PATTERN.test(challenge)) {
      return appendAuthorizationError(
        redirectUri,
        "invalid_request",
        "Authorization request is invalid",
        state,
        issuer,
      );
    }
    const issueRateLimit: number = connectorAuthorizationIssueRateLimit(
      dependencies.authorizationCodeLifetimeMs,
      dependencies.maximumAuthorizationCodes,
      dependencies.authorizationRateLimitPerMinute,
    );
    if (
      issueRateLimit < 1 ||
      !dependencies.capacity.rateLimitAllows("connector-oauth:authorize", issueRateLimit)
    ) {
      return appendAuthorizationError(
        redirectUri,
        "temporarily_unavailable",
        "Authorization service is busy",
        state,
        issuer,
      );
    }
    const code: string | null = dependencies.codeStore.issue({
      clientId,
      codeChallenge: challenge,
      issuer,
      redirectUri,
      resource,
      scope,
    });
    return code === null
      ? appendAuthorizationError(
          redirectUri,
          "temporarily_unavailable",
          "Authorization service is busy",
          state,
          issuer,
        )
      : appendAuthorizationResult(redirectUri, code, state, issuer);
  } catch (error: unknown) {
    if (error instanceof InvalidConnectorOAuthRequestError) {
      return redirectUri === null
        ? oauthError(400, "invalid_request", "Authorization request is invalid")
        : appendAuthorizationError(
            redirectUri,
            "invalid_request",
            "Authorization request is invalid",
            state,
            issuer,
          );
    }
    throw error;
  }
}

function decodeBasicCredential(authorization: string): ClientCredential | null {
  if (!authorization.startsWith("Basic ")) return null;
  const encoded: string = authorization.slice("Basic ".length).trim();
  if (encoded === "" || encoded.length > 4_096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    return null;
  }
  let decoded: string;
  try {
    const bytes: Buffer = Buffer.from(encoded, "base64");
    const unpadded: string = encoded.replace(/=+$/u, "");
    if (bytes.toString("base64").replace(/=+$/u, "") !== unpadded) return null;
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_error: unknown) {
    return null;
  }
  const separator: number = decoded.indexOf(":");
  if (separator <= 0) return null;
  const clientId: string = decoded.slice(0, separator);
  const secret: string = decoded.slice(separator + 1);
  return secret === "" || secret.length > MAXIMUM_SECRET_CHARACTERS ? null : { clientId, secret };
}

function clientCredential(request: Request, parameters: URLSearchParams): ClientCredential | null {
  const authorization: string | null = request.headers.get("authorization");
  const postedClientId: string | null = singleParameter(parameters, "client_id", 64);
  const postedSecret: string | null = singleParameter(
    parameters,
    "client_secret",
    MAXIMUM_SECRET_CHARACTERS,
  );
  if (authorization !== null) {
    if (postedClientId !== null || postedSecret !== null) return null;
    return decodeBasicCredential(authorization);
  }
  return postedClientId === null || postedSecret === null
    ? null
    : { clientId: postedClientId, secret: postedSecret };
}

async function formParameters(request: Request): Promise<URLSearchParams> {
  const contentType: string = request.headers.get("content-type") ?? "";
  const mediaType: string | undefined = contentType.split(";", 1)[0];
  if (
    mediaType === undefined ||
    mediaType.trim().toLowerCase() !== "application/x-www-form-urlencoded"
  ) {
    throw new InvalidConnectorOAuthRequestError();
  }
  const bytes: Uint8Array = await requestBodyBytes(request, MAXIMUM_FORM_BYTES);
  const decoded: string = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return new URLSearchParams(decoded);
}

function authenticationFailure(result: HostedAuthenticationResult): Response {
  if (result.kind === "capacity") {
    const response: Response = oauthError(
      503,
      "temporarily_unavailable",
      "Authentication service is busy",
    );
    response.headers.set("retry-after", "1");
    return response;
  }
  if (result.kind === "unavailable") {
    return oauthError(503, "temporarily_unavailable", "Authentication service is unavailable");
  }
  return oauthError(401, "invalid_client", "Client authentication failed", true);
}

async function handleToken(
  request: Request,
  dependencies: ConnectorOAuthDependencies,
  observation: RequestObservation,
  issuer: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    const parameters: URLSearchParams = await formParameters(request);
    const credential: ClientCredential | null = clientCredential(request, parameters);
    if (credential === null || credential.clientId !== CONNECTOR_CLIENT_ID) {
      observation.recordCredential("missing");
      observation.recordAuthentication("invalid");
      return oauthError(401, "invalid_client", "Client authentication failed", true);
    }
    const authentication: HostedAuthenticationResult = await authenticateHostedCredential(
      credential.secret,
      dependencies.authenticator,
      dependencies.capacity,
      observation,
    );
    if (authentication.kind !== "authenticated") return authenticationFailure(authentication);
    const principal: HostedPrincipal = authentication.principal;
    if (principal.kind !== "tenant") {
      return oauthError(401, "invalid_client", "Client authentication failed", true);
    }
    const principalIdentity: string = dependencies.authenticator.identity(principal);
    if (!dependencies.capacity.rateLimitAllows(principalIdentity)) {
      observation.recordPrincipalRateLimit("rejected");
      return oauthRateLimitError();
    }
    observation.recordPrincipalRateLimit("allowed");
    const tenantRateIdentity: string = `tenant-quota:${principal.tenantId.value}`;
    if (
      !dependencies.capacity.rateLimitAllows(
        tenantRateIdentity,
        dependencies.tenantRateLimitPerMinute,
      )
    ) {
      observation.recordTenantRateLimit("rejected");
      return oauthRateLimitError();
    }
    observation.recordTenantRateLimit("allowed");
    const clientId: string = credential.clientId;
    const grantType: string = requiredParameter(parameters, "grant_type", 64);
    if (grantType !== "authorization_code") {
      return oauthError(400, "unsupported_grant_type", "Token grant type is unsupported");
    }
    const code: string = requiredParameter(parameters, "code", 128);
    const verifier: string = requiredParameter(parameters, "code_verifier", 128);
    const redirectValue: string = requiredParameter(parameters, "redirect_uri", 2_048);
    const redirectUri: string | null = exactRedirectUri(
      redirectValue,
      dependencies.allowedRedirectUris,
    );
    const resource: string = requiredParameter(parameters, "resource", 2_048);
    if (resource !== mcpResource(issuer)) {
      return oauthError(400, "invalid_target", "Token resource is invalid");
    }
    if (!CODE_PATTERN.test(code) || !CODE_VERIFIER_PATTERN.test(verifier) || redirectUri === null) {
      return oauthError(400, "invalid_grant", "Authorization grant is invalid or expired");
    }
    const grant: ConnectorAuthorizationGrant | null = dependencies.codeStore.consume({
      clientId,
      code,
      codeVerifier: verifier,
      issuer,
      redirectUri,
      resource,
    });
    if (grant === null) {
      return oauthError(400, "invalid_grant", "Authorization grant is invalid or expired");
    }
    return jsonResponse(200, {
      access_token: credential.secret,
      scope: grant.scope,
      token_type: "Bearer",
    });
  } catch (error: unknown) {
    if (
      error instanceof InvalidConnectorOAuthRequestError ||
      error instanceof RequestBodyTooLargeError ||
      error instanceof TypeError
    ) {
      return oauthError(400, "invalid_request", "Token request is invalid");
    }
    throw error;
  }
}

export function isConnectorOAuthPath(pathname: string): boolean {
  return (
    pathname === OAUTH_AUTHORIZATION_PATH ||
    pathname === OAUTH_TOKEN_PATH ||
    pathname === OAUTH_SERVER_METADATA_PATH ||
    pathname === OAUTH_PROTECTED_RESOURCE_PATH ||
    pathname === OAUTH_PROTECTED_RESOURCE_ROOT_PATH
  );
}

export function createConnectorOAuthHandler(
  dependencies: ConnectorOAuthDependencies,
): (request: Request, observation: RequestObservation) => Promise<Response> {
  return async (request: Request, observation: RequestObservation): Promise<Response> => {
    const releaseRequestCapacity: (() => void) | null =
      dependencies.capacity.reservePublicRequest("connector-oauth:public");
    if (releaseRequestCapacity === null) {
      observation.recordRequestCapacity("rejected");
      const response: Response = oauthError(
        503,
        "temporarily_unavailable",
        "OAuth request capacity reached",
      );
      response.headers.set("retry-after", "1");
      return response;
    }
    observation.recordRequestCapacity("allowed");
    try {
      const issuer: string | null = issuerForRequest(request, dependencies.publicOrigin);
      if (issuer === null) {
        return oauthError(503, "temporarily_unavailable", "OAuth public origin is unavailable");
      }
      const pathname: string = new URL(request.url).pathname;
      if (pathname === OAUTH_AUTHORIZATION_PATH) {
        return handleAuthorization(request, dependencies, issuer);
      }
      if (pathname === OAUTH_TOKEN_PATH) {
        return await handleToken(request, dependencies, observation, issuer);
      }
      if (request.method !== "GET") return methodNotAllowed("GET");
      return pathname === OAUTH_SERVER_METADATA_PATH
        ? authorizationServerMetadata(issuer)
        : protectedResourceMetadata(issuer);
    } finally {
      releaseRequestCapacity();
    }
  };
}
