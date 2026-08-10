#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { AgentClient, BranchName, RepositoryName, type TenantId } from "./domain/value-objects.js";
import { createHostedAuthenticator, type HostedAuthenticator } from "./hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "./hosted/control-plane.js";
import { hashTokenSecret } from "./hosted/token-secret.js";
import { MurmurApplication } from "./mcp/murmur-application.js";
import { logSafeError } from "./safe-errors.js";
import { createStore } from "./storage/create-store.js";
import type { MessageStore } from "./storage/message-store.js";

const DEFAULT_PORT: number = 8080;
const HEALTH_PATH: string = "/health";
const MCP_PATH: string = "/mcp";
const BRANCH_HEADER: string = "x-murmur-branch";
const CLIENT_HEADER: string = "x-murmur-client";
const REPOSITORY_HEADER: string = "x-murmur-repository";
const SSE_KEEP_ALIVE_MS: number = 1_000;
const DEFAULT_MAX_REQUEST_BYTES: number = 1_048_576;
const DEFAULT_MAX_SESSIONS: number = 1_000;
const DEFAULT_MAX_SESSIONS_PER_TENANT: number = 100;
const DEFAULT_MAX_AUTHENTICATIONS: number = 4;
const DEFAULT_AUTHENTICATION_WAIT_MS: number = 2_000;
const DEFAULT_MAX_PENDING_AUTHENTICATIONS: number = 32;
const DEFAULT_MAX_PENDING_AUTHENTICATIONS_PER_TENANT: number = 8;
const DEFAULT_MAX_ACTIVE_REQUESTS: number = 64;
const DEFAULT_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: number = 8;
const DEFAULT_MAX_ACTIVE_REQUESTS_PER_TENANT: number = 20;
const DEFAULT_SESSION_IDLE_MS: number = 15 * 60 * 1_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE: number = 600;
const DEFAULT_TENANT_RATE_LIMIT_PER_MINUTE: number = 3_000;
type RemoteSession = {
  activeResponses: number;
  readonly application: MurmurApplication;
  lastSeenAt: number;
  readonly principalIdentity: string;
  readonly tenantId: string | null;
  readonly tokenId: string | null;
  readonly transport: WebStandardStreamableHTTPServerTransport;
};

function responseWithFinish(response: Response, onFinish: () => void): Response {
  if (response.body === null) {
    onFinish();
    return response;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let finished: boolean = false;
  const finish: () => void = (): void => {
    if (finished) return;
    finished = true;
    onFinish();
  };
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    cancel: async (reason: unknown): Promise<void> => {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
    pull: async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      try {
        const result: { readonly done: boolean; readonly value?: Uint8Array | undefined } =
          await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error: unknown) {
        finish();
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function trackedResponse(response: Response, session: RemoteSession): Response {
  if (response.body === null) return response;
  session.activeResponses += 1;
  return responseWithFinish(response, (): void => {
    session.activeResponses -= 1;
  });
}

type RateWindow = {
  count: number;
  startedAt: number;
};

async function waitForCapacity(waiters: Set<() => void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve: () => void): void => {
    const finish: () => void = (): void => {
      clearTimeout(timeout);
      waiters.delete(finish);
      resolve();
    };
    const timeout: ReturnType<typeof setTimeout> = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
}

export type MurmurHttpServer = {
  readonly mcpUrl: URL;
  readonly port: number;
  stop(): Promise<void>;
};

export type HttpServerDependencies = {
  readonly authenticator?: HostedAuthenticator;
};

function parsePort(environment: NodeJS.ProcessEnv): number {
  const configured: string | undefined = environment["PORT"];
  if (configured === undefined || configured === "") return DEFAULT_PORT;
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

function bearerToken(request: Request): string | null {
  const authorization: string | null = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token: string = authorization.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function authenticationCapacityResponse(): Response {
  return Response.json(
    { error: "Authentication capacity reached" },
    {
      headers: { "cache-control": "no-store", "retry-after": "1" },
      status: 503,
    },
  );
}

function unauthorizedResponse(): Response {
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="murmur"',
    },
    status: 401,
  });
}

function originIsAllowed(request: Request, allowedOrigins: ReadonlySet<string>): boolean {
  const origin: string | null = request.headers.get("origin");
  return origin === null || allowedOrigins.has(origin);
}

function repositoryFromRequest(request: Request): RepositoryName | null {
  const configured: string | null = request.headers.get(REPOSITORY_HEADER);
  return configured === null || configured.trim() === "" ? null : RepositoryName.parse(configured);
}

function branchFromRequest(request: Request): BranchName | null {
  const configured: string | null = request.headers.get(BRANCH_HEADER);
  return configured === null || configured.trim() === "" ? null : BranchName.parse(configured);
}

function clientFromRequest(request: Request): AgentClient | null {
  const configured: string | null = request.headers.get(CLIENT_HEADER);
  return configured === null || configured.trim() === ""
    ? null
    : AgentClient.parse(configured.trim().toLowerCase());
}

function requestSessionId(request: Request): string | null {
  const value: string | null = request.headers.get("mcp-session-id");
  return value === null || value.trim() === "" ? null : value;
}

class RequestBodyTooLargeError extends Error {
  public constructor(limit: number) {
    super(`The MCP request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

async function requestBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength: string | null = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) return new Uint8Array();
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  try {
    while (true) {
      const result: {
        readonly done: boolean;
        readonly value?: Uint8Array | undefined;
      } = await reader.read();
      if (result.done) break;
      const value: Uint8Array | undefined = result.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error: unknown) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  chunks.forEach((chunk: Uint8Array): void => {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return merged;
}

async function parseRequestBody(request: Request, maxBytes: number): Promise<unknown> {
  try {
    const bytes: Uint8Array = await requestBodyBytes(request, maxBytes);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw new Error("The MCP request body must be valid JSON", {
      cause: error,
    });
  }
}

export async function startHttpServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HttpServerDependencies = {},
): Promise<MurmurHttpServer> {
  const allowedOrigins: ReadonlySet<string> = parseAllowedOrigins(environment);
  const hostname: string = environment["MURMUR_HTTP_HOST"] ?? "0.0.0.0";
  const requestedPort: number = parsePort(environment);
  const maxRequestBytes: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_REQUEST_BYTES",
    DEFAULT_MAX_REQUEST_BYTES,
  );
  const maxSessions: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_SESSIONS",
    DEFAULT_MAX_SESSIONS,
  );
  const maxSessionsPerTenant: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_SESSIONS_PER_TENANT",
    DEFAULT_MAX_SESSIONS_PER_TENANT,
  );
  const maxAuthentications: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_CONCURRENT_AUTHENTICATIONS",
    DEFAULT_MAX_AUTHENTICATIONS,
  );
  const authenticationWaitMs: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_AUTHENTICATION_WAIT_MS",
    DEFAULT_AUTHENTICATION_WAIT_MS,
  );
  const maxPendingAuthentications: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_PENDING_AUTHENTICATIONS",
    DEFAULT_MAX_PENDING_AUTHENTICATIONS,
  );
  const maxPendingAuthenticationsPerTenant: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT",
    DEFAULT_MAX_PENDING_AUTHENTICATIONS_PER_TENANT,
  );
  const maxActiveRequests: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_ACTIVE_REQUESTS",
    DEFAULT_MAX_ACTIVE_REQUESTS,
  );
  const maxActiveRequestsPerPrincipal: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL",
    DEFAULT_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL,
  );
  const maxActiveRequestsPerTenant: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT",
    DEFAULT_MAX_ACTIVE_REQUESTS_PER_TENANT,
  );
  const sessionIdleMs: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_SESSION_IDLE_MS",
    DEFAULT_SESSION_IDLE_MS,
  );
  const rateLimitPerMinute: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_RATE_LIMIT_PER_MINUTE",
    DEFAULT_RATE_LIMIT_PER_MINUTE,
  );
  const tenantRateLimitPerMinute: number = positiveIntegerEnvironment(
    environment,
    "MURMUR_TENANT_RATE_LIMIT_PER_MINUTE",
    DEFAULT_TENANT_RATE_LIMIT_PER_MINUTE,
  );
  const store: MessageStore = await createStore(environment);
  let authenticator: HostedAuthenticator | undefined = dependencies.authenticator;
  if (authenticator === undefined) {
    try {
      authenticator = await createHostedAuthenticator(environment);
    } catch (error: unknown) {
      await store.close();
      throw error;
    }
  }
  const sessions: Map<string, RemoteSession> = new Map<string, RemoteSession>();
  const rateWindows: Map<string, RateWindow> = new Map<string, RateWindow>();
  const initializingByTenant: Map<string, number> = new Map<string, number>();
  const activeRequestsByPrincipal: Map<string, number> = new Map<string, number>();
  const activeRequestsByTenant: Map<string, number> = new Map<string, number>();
  const activeAuthenticationsByCredential: Map<string, number> = new Map<string, number>();
  const activeAuthenticationsByTenant: Map<string, number> = new Map<string, number>();
  const pendingAuthenticationsByTenant: Map<string, number> = new Map<string, number>();
  const authenticationCapacityWaiters: Set<() => void> = new Set<() => void>();
  let activeAuthentications: number = 0;
  let pendingAuthentications: number = 0;
  let activeRequests: number = 0;
  let initializingSessions: number = 0;
  let stopped: boolean = false;

  const closeSessions: (
    matches: readonly [string, RemoteSession][],
    context: string,
  ) => Promise<void> = async (
    matches: readonly [string, RemoteSession][],
    context: string,
  ): Promise<void> => {
    matches.forEach((entry: [string, RemoteSession]): void => {
      sessions.delete(entry[0]);
    });
    const results: PromiseSettledResult<void>[] = await Promise.allSettled(
      matches.map(
        async (entry: [string, RemoteSession]): Promise<void> => await entry[1].application.close(),
      ),
    );
    results.forEach((result: PromiseSettledResult<void>): void => {
      if (result.status === "rejected") logSafeError(context, result.reason);
    });
  };

  const closeSessionsForToken: (tokenId: string) => Promise<void> = async (
    tokenId: string,
  ): Promise<void> => {
    const matches: [string, RemoteSession][] = Array.from(sessions.entries()).filter(
      (entry: [string, RemoteSession]): boolean => entry[1].tokenId === tokenId,
    );
    await closeSessions(matches, "Murmur revoked-session shutdown failed");
  };

  const closeSessionsForTenant: (tenantId: TenantId) => Promise<void> = async (
    tenantId: TenantId,
  ): Promise<void> => {
    const matches: [string, RemoteSession][] = Array.from(sessions.entries()).filter(
      (entry: [string, RemoteSession]): boolean => entry[1].tenantId === tenantId.value,
    );
    await closeSessions(matches, "Murmur suspended-tenant session shutdown failed");
  };

  const scheduleCloseSessionsForToken: (tokenId: string) => Promise<void> = async (
    tokenId: string,
  ): Promise<void> => {
    setTimeout((): void => {
      void closeSessionsForToken(tokenId).catch((error: unknown): void => {
        logSafeError("Murmur revoked-session shutdown failed", error);
      });
    }, 0);
  };

  const scheduleCloseSessionsForTenant: (tenantId: TenantId) => Promise<void> = async (
    tenantId: TenantId,
  ): Promise<void> => {
    setTimeout((): void => {
      void closeSessionsForTenant(tenantId).catch((error: unknown): void => {
        logSafeError("Murmur suspended-tenant session shutdown failed", error);
      });
    }, 0);
  };

  const expireIdleSessions: (now: number) => Promise<void> = async (now: number): Promise<void> => {
    const expired: [string, RemoteSession][] = Array.from(sessions.entries()).filter(
      (entry: [string, RemoteSession]): boolean =>
        entry[1].activeResponses === 0 && now - entry[1].lastSeenAt >= sessionIdleMs,
    );
    Array.from(rateWindows.entries()).forEach((entry: [string, RateWindow]): void => {
      if (now - entry[1].startedAt >= 120_000) rateWindows.delete(entry[0]);
    });
    await closeSessions(expired, "Murmur idle-session shutdown failed");
  };

  const rateLimitAllows: (identity: string, now: number, limit?: number) => boolean = (
    identity: string,
    now: number,
    limit: number = rateLimitPerMinute,
  ): boolean => {
    const existing: RateWindow | undefined = rateWindows.get(identity);
    if (existing === undefined || now - existing.startedAt >= 60_000) {
      rateWindows.set(identity, { count: 1, startedAt: now });
      return true;
    }
    existing.count += 1;
    return existing.count <= limit;
  };

  const reserveRequestCapacity: (
    principalIdentity: string,
    tenantId: string | null,
  ) => (() => void) | null = (
    principalIdentity: string,
    tenantId: string | null,
  ): (() => void) | null => {
    const principalRequests: number = activeRequestsByPrincipal.get(principalIdentity) ?? 0;
    const tenantRequests: number =
      tenantId === null ? 0 : (activeRequestsByTenant.get(tenantId) ?? 0);
    if (
      activeRequests >= maxActiveRequests ||
      principalRequests >= maxActiveRequestsPerPrincipal ||
      (tenantId !== null && tenantRequests >= maxActiveRequestsPerTenant)
    ) {
      return null;
    }
    activeRequests += 1;
    activeRequestsByPrincipal.set(principalIdentity, principalRequests + 1);
    if (tenantId !== null) activeRequestsByTenant.set(tenantId, tenantRequests + 1);
    let released: boolean = false;
    return (): void => {
      if (released) return;
      released = true;
      activeRequests -= 1;
      const remainingForPrincipal: number =
        (activeRequestsByPrincipal.get(principalIdentity) ?? 1) - 1;
      if (remainingForPrincipal === 0) activeRequestsByPrincipal.delete(principalIdentity);
      else activeRequestsByPrincipal.set(principalIdentity, remainingForPrincipal);
      if (tenantId !== null) {
        const remainingForTenant: number = (activeRequestsByTenant.get(tenantId) ?? 1) - 1;
        if (remainingForTenant === 0) activeRequestsByTenant.delete(tenantId);
        else activeRequestsByTenant.set(tenantId, remainingForTenant);
      }
    };
  };

  const notifyAuthenticationCapacityChanged: () => void = (): void => {
    const waiters: readonly (() => void)[] = Array.from(authenticationCapacityWaiters);
    authenticationCapacityWaiters.clear();
    waiters.forEach((wake: () => void): void => {
      wake();
    });
  };

  const tryReserveAuthenticationCapacity: (
    admissionKey: string,
    admittedTenantKey: string | null,
    knownCredential: boolean,
  ) => (() => void) | null = (
    admissionKey: string,
    admittedTenantKey: string | null,
    knownCredential: boolean,
  ): (() => void) | null => {
    const activeForCredential: number = activeAuthenticationsByCredential.get(admissionKey) ?? 0;
    const activeForAdmittedTenant: number =
      admittedTenantKey === null ? 0 : (activeAuthenticationsByTenant.get(admittedTenantKey) ?? 0);
    const unknownAuthenticationLimit: number = Math.max(1, maxAuthentications - 1);
    if (
      activeAuthentications >= maxAuthentications ||
      activeForCredential >= 1 ||
      activeForAdmittedTenant >= 2 ||
      (!knownCredential && activeAuthentications >= unknownAuthenticationLimit)
    ) {
      return null;
    }
    activeAuthentications += 1;
    activeAuthenticationsByCredential.set(admissionKey, activeForCredential + 1);
    if (admittedTenantKey !== null) {
      activeAuthenticationsByTenant.set(admittedTenantKey, activeForAdmittedTenant + 1);
    }
    let released: boolean = false;
    return (): void => {
      if (released) return;
      released = true;
      activeAuthentications -= 1;
      activeAuthenticationsByCredential.delete(admissionKey);
      if (admittedTenantKey !== null) {
        const remainingForTenant: number =
          (activeAuthenticationsByTenant.get(admittedTenantKey) ?? 1) - 1;
        if (remainingForTenant === 0) {
          activeAuthenticationsByTenant.delete(admittedTenantKey);
        } else {
          activeAuthenticationsByTenant.set(admittedTenantKey, remainingForTenant);
        }
      }
      notifyAuthenticationCapacityChanged();
    };
  };

  const reserveAuthenticationCapacity: (
    admissionKey: string,
    admittedTenantKey: string | null,
    knownCredential: boolean,
  ) => Promise<(() => void) | null> = async (
    admissionKey: string,
    admittedTenantKey: string | null,
    knownCredential: boolean,
  ): Promise<(() => void) | null> => {
    if (stopped) return null;
    const immediateReservation: (() => void) | null = tryReserveAuthenticationCapacity(
      admissionKey,
      admittedTenantKey,
      knownCredential,
    );
    if (immediateReservation !== null || !knownCredential) return immediateReservation;
    const pendingForTenant: number =
      admittedTenantKey === null ? 0 : (pendingAuthenticationsByTenant.get(admittedTenantKey) ?? 0);
    if (
      pendingAuthentications >= maxPendingAuthentications ||
      (admittedTenantKey !== null && pendingForTenant >= maxPendingAuthenticationsPerTenant)
    ) {
      return null;
    }
    pendingAuthentications += 1;
    if (admittedTenantKey !== null) {
      pendingAuthenticationsByTenant.set(admittedTenantKey, pendingForTenant + 1);
    }
    const deadline: number = Date.now() + authenticationWaitMs;
    try {
      while (!stopped && Date.now() < deadline) {
        const reservation: (() => void) | null = tryReserveAuthenticationCapacity(
          admissionKey,
          admittedTenantKey,
          knownCredential,
        );
        if (reservation !== null) return reservation;
        const remainingMs: number = deadline - Date.now();
        if (remainingMs > 0) {
          await waitForCapacity(authenticationCapacityWaiters, remainingMs);
        }
      }
      return null;
    } finally {
      pendingAuthentications -= 1;
      if (admittedTenantKey !== null) {
        const remainingForTenant: number =
          (pendingAuthenticationsByTenant.get(admittedTenantKey) ?? 1) - 1;
        if (remainingForTenant === 0) pendingAuthenticationsByTenant.delete(admittedTenantKey);
        else pendingAuthenticationsByTenant.set(admittedTenantKey, remainingForTenant);
      }
    }
  };

  const handleMcpRequest: (request: Request) => Promise<Response> = async (
    request: Request,
  ): Promise<Response> => {
    if (!originIsAllowed(request, allowedOrigins)) {
      return jsonResponse(403, { error: "Origin is not allowed" });
    }
    const token: string | null = bearerToken(request);
    if (token === null) return unauthorizedResponse();
    const registeredAdmission: CredentialAdmission | null =
      authenticator.credentialAdmission(token);
    const admittedTenantKey: string | null =
      registeredAdmission === null ? null : registeredAdmission.tenantKey;
    const admissionKey: string =
      registeredAdmission === null
        ? hashTokenSecret(token).toString("base64url")
        : registeredAdmission.key;
    const knownCredential: boolean = registeredAdmission !== null;
    const releaseAuthenticationCapacity: (() => void) | null = await reserveAuthenticationCapacity(
      admissionKey,
      admittedTenantKey,
      knownCredential,
    );
    if (releaseAuthenticationCapacity === null) return authenticationCapacityResponse();
    let principal: HostedPrincipal | null;
    try {
      principal = await authenticator.authenticate(token);
    } catch (error: unknown) {
      logSafeError("Murmur authentication backend error", error);
      return jsonResponse(503, { error: "Authentication service unavailable" });
    } finally {
      releaseAuthenticationCapacity();
    }
    if (principal === null) return unauthorizedResponse();

    const principalIdentity: string = authenticator.identity(principal);
    const tenantId: string | null = principal.kind === "tenant" ? principal.tenantId.value : null;
    const releaseRequestCapacity: (() => void) | null = reserveRequestCapacity(
      principalIdentity,
      tenantId,
    );
    if (releaseRequestCapacity === null) {
      return jsonResponse(503, { error: "MCP request capacity reached" });
    }
    let responseHandedOff: boolean = false;
    try {
      const response: Response = await (async (): Promise<Response> => {
        const now: number = Date.now();
        await expireIdleSessions(now);
        if (!rateLimitAllows(principalIdentity, now)) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
              "retry-after": "60",
            },
            status: 429,
          });
        }
        const tenantRateIdentity: string | null =
          principal.kind === "tenant" ? `tenant-quota:${principal.tenantId.value}` : null;
        if (
          tenantRateIdentity !== null &&
          !rateLimitAllows(tenantRateIdentity, now, tenantRateLimitPerMinute)
        ) {
          return new Response(JSON.stringify({ error: "Tenant rate limit exceeded" }), {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
              "retry-after": "60",
            },
            status: 429,
          });
        }

        let parsedPostBody: unknown;
        if (request.method === "POST") {
          try {
            parsedPostBody = await parseRequestBody(request, maxRequestBytes);
          } catch (error: unknown) {
            const message: string = error instanceof Error ? error.message : String(error);
            return jsonResponse(error instanceof RequestBodyTooLargeError ? 413 : 400, {
              error: message,
            });
          }
        }

        const sessionId: string | null = requestSessionId(request);
        if (sessionId !== null) {
          const session: RemoteSession | undefined = sessions.get(sessionId);
          if (session === undefined || session.principalIdentity !== principalIdentity) {
            return jsonResponse(404, { error: "MCP session not found" });
          }
          session.lastSeenAt = now;
          const response: Response = await session.transport.handleRequest(
            request,
            parsedPostBody === undefined ? undefined : { parsedBody: parsedPostBody },
          );
          return trackedResponse(response, session);
        }

        if (request.method !== "POST") {
          return jsonResponse(400, { error: "Mcp-Session-Id header is required" });
        }

        if (!isInitializeRequest(parsedPostBody)) {
          return jsonResponse(400, { error: "Initialize the MCP session first" });
        }
        let branchName: BranchName | null;
        let client: AgentClient | null;
        let repositoryName: RepositoryName | null;
        try {
          branchName = branchFromRequest(request);
          client = clientFromRequest(request);
          repositoryName = repositoryFromRequest(request);
        } catch (error: unknown) {
          const message: string = error instanceof Error ? error.message : String(error);
          return jsonResponse(400, {
            error: `Invalid Murmur context header: ${message}`,
          });
        }
        if (sessions.size + initializingSessions >= maxSessions) {
          return jsonResponse(503, { error: "MCP session capacity reached" });
        }
        if (tenantId !== null) {
          const establishedForTenant: number = Array.from(sessions.values()).filter(
            (session: RemoteSession): boolean => session.tenantId === tenantId,
          ).length;
          const initializingForTenant: number = initializingByTenant.get(tenantId) ?? 0;
          if (establishedForTenant + initializingForTenant >= maxSessionsPerTenant) {
            return jsonResponse(503, { error: "Tenant MCP session capacity reached" });
          }
        }

        const transport: WebStandardStreamableHTTPServerTransport =
          new WebStandardStreamableHTTPServerTransport({
            keepAliveMs: SSE_KEEP_ALIVE_MS,
            sessionIdGenerator: randomUUID,
          });
        const application: MurmurApplication = new MurmurApplication({
          branchName,
          bootstrapCredentialHash: authenticator.bootstrapCredentialHash(principal, token),
          client,
          closeStoreOnClose: false,
          controlPlane: authenticator.controlPlane,
          legacyCredentialHash: authenticator.legacyCredentialHash(principal),
          onTenantSuspended: scheduleCloseSessionsForTenant,
          onTokenRevoked: scheduleCloseSessionsForToken,
          principal,
          repositoryName,
          store: principal.kind === "tenant" ? store.scope(principal.tenantId) : null,
          tenantOnboardingEnabled: authenticator.tenantOnboardingEnabled,
        });
        const session: RemoteSession = {
          activeResponses: 0,
          application,
          lastSeenAt: now,
          principalIdentity,
          tenantId: principal.kind === "tenant" ? principal.tenantId.value : null,
          tokenId: principal.tokenId,
          transport,
        };
        initializingSessions += 1;
        if (tenantId !== null) {
          initializingByTenant.set(tenantId, (initializingByTenant.get(tenantId) ?? 0) + 1);
        }
        transport.onclose = (): void => {
          const closedSessionId: string | undefined = transport.sessionId;
          if (closedSessionId !== undefined) sessions.delete(closedSessionId);
        };
        try {
          await application.server.connect(transport);
          const response: Response = await transport.handleRequest(request, {
            parsedBody: parsedPostBody,
          });
          const initializedSessionId: string | undefined = transport.sessionId;
          if (initializedSessionId === undefined) {
            await application.close();
          } else {
            sessions.set(initializedSessionId, session);
          }
          return response;
        } catch (error: unknown) {
          try {
            await application.close();
          } catch (closeError: unknown) {
            logSafeError("Murmur failed-session shutdown failed", closeError);
          }
          throw error;
        } finally {
          initializingSessions -= 1;
          if (tenantId !== null) {
            const remaining: number = (initializingByTenant.get(tenantId) ?? 1) - 1;
            if (remaining === 0) initializingByTenant.delete(tenantId);
            else initializingByTenant.set(tenantId, remaining);
          }
        }
      })();
      const capacityTrackedResponse: Response = responseWithFinish(
        response,
        releaseRequestCapacity,
      );
      responseHandedOff = true;
      return capacityTrackedResponse;
    } finally {
      if (!responseHandedOff) releaseRequestCapacity();
    }
  };

  const bunServer: Bun.Server<undefined> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      try {
        const url: URL = new URL(request.url);
        if (url.pathname === "/" || url.pathname === HEALTH_PATH) {
          if (request.method !== "GET") {
            return new Response(null, {
              headers: { allow: "GET" },
              status: 405,
            });
          }
          return jsonResponse(200, { service: "murmur", status: "ok" });
        }
        if (url.pathname !== MCP_PATH) return jsonResponse(404, { error: "Not found" });
        return await handleMcpRequest(request);
      } catch (error: unknown) {
        logSafeError("Murmur HTTP request failed", error);
        return jsonResponse(500, { error: "Internal server error" });
      }
    },
    hostname,
    port: requestedPort,
  });

  const boundPort: number | undefined = bunServer.port;
  if (boundPort === undefined) {
    await authenticator.close();
    await store.close();
    await bunServer.stop(true);
    throw new Error("The HTTP server did not bind a TCP port");
  }
  const port: number = boundPort;
  const publicHostname: string = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const mcpUrl: URL = new URL(`http://${publicHostname}:${port}${MCP_PATH}`);

  return {
    mcpUrl,
    port,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      notifyAuthenticationCapacityChanged();
      const activeSessions: [string, RemoteSession][] = Array.from(sessions.entries());
      await closeSessions(activeSessions, "Murmur active-session shutdown failed");
      await authenticator.close();
      await store.close();
      await bunServer.stop(true);
    },
  };
}

if (import.meta.main) {
  startHttpServer()
    .then((server: MurmurHttpServer): void => {
      console.log(`Murmur remote MCP listening on port ${server.port}`);
      let shuttingDown: boolean = false;
      const shutdown: () => Promise<void> = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        await server.stop();
      };
      process.once("SIGINT", (): void => {
        void shutdown().catch((error: unknown): void => {
          logSafeError("Murmur HTTP shutdown failed", error);
          process.exitCode = 1;
        });
      });
      process.once("SIGTERM", (): void => {
        void shutdown().catch((error: unknown): void => {
          logSafeError("Murmur HTTP shutdown failed", error);
          process.exitCode = 1;
        });
      });
    })
    .catch((error: unknown): void => {
      logSafeError("Murmur HTTP startup failed", error);
      process.exitCode = 1;
    });
}
