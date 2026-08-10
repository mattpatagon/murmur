#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AgentClient, BranchName, RepositoryName, TenantId } from "./domain/value-objects.js";
import { createHostedAuthenticator, type HostedAuthenticator } from "./hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "./hosted/control-plane.js";
import { hashTokenSecret } from "./hosted/token-secret.js";
import {
  HttpCapacityController,
  SYSTEM_TIME_SOURCE,
  type TimeSource,
} from "./http/http-capacity.js";
import {
  type HttpServerConfig,
  MCP_PATH,
  parseHttpServerConfig,
  SSE_KEEP_ALIVE_MS,
} from "./http/http-config.js";
import {
  authenticationCapacityResponse,
  bearerToken,
  branchFromRequest,
  clientFromRequest,
  jsonResponse,
  mcpRequestMetadata,
  originIsAllowed,
  parseRequestBody,
  RequestBodyTooLargeError,
  repositoryFromRequest,
  requestSessionId,
  streamCapacityResponse,
  unauthorizedResponse,
} from "./http/http-request.js";
import { createHttpRequestHandler } from "./http/http-router.js";
import {
  cleanupObservabilityStartup,
  cleanupServerStartup,
  cleanupStoreStartup,
  shutdownHttpResources,
} from "./http/http-server-resources.js";
import type { RemoteSession } from "./http/remote-session.js";
import { responseWithFinish, trackedResponse } from "./http/response-lifecycle.js";
import { MurmurApplication } from "./mcp/murmur-application.js";
import {
  createDefaultHttpObservability,
  type HttpObservability,
  type RequestObservation,
} from "./observability/request-observation.js";
import { recordRepositoryDivergence } from "./observability/lifecycle-metrics.js";
import { logSafeError } from "./safe-errors.js";
import { createStore } from "./storage/create-store.js";
import type { MessageStore } from "./storage/message-store.js";

export type MurmurHttpServer = {
  readonly mcpUrl: URL;
  readonly port: number;
  stop(): Promise<void>;
};

export type HttpServerDependencies = {
  readonly authenticator?: HostedAuthenticator;
  readonly observability?: HttpObservability;
  readonly timeSource?: TimeSource;
};

export async function startHttpServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HttpServerDependencies = {},
): Promise<MurmurHttpServer> {
  const config: HttpServerConfig = parseHttpServerConfig(environment);
  const allowedOrigins: ReadonlySet<string> = config.allowedOrigins;
  const hostname: string = config.hostname;
  const maxRequestBytes: number = config.maxRequestBytes;
  const maxSessions: number = config.maxSessions;
  const maxSessionsPerTenant: number = config.maxSessionsPerTenant;
  const requestedPort: number = config.requestedPort;
  const sessionIdleMs: number = config.sessionIdleMs;
  const tenantRateLimitPerMinute: number = config.tenantRateLimitPerMinute;
  const capacity: HttpCapacityController = new HttpCapacityController(
    config,
    dependencies.timeSource ?? SYSTEM_TIME_SOURCE,
  );
  const store: MessageStore = await createStore(environment);
  let authenticator: HostedAuthenticator | undefined = dependencies.authenticator;
  if (authenticator === undefined) {
    try {
      authenticator = await createHostedAuthenticator(environment);
    } catch (error: unknown) {
      capacity.stop();
      await cleanupStoreStartup(store);
      throw error;
    }
  }
  let observability: HttpObservability | undefined = dependencies.observability;
  if (observability === undefined) {
    try {
      observability = createDefaultHttpObservability(environment);
    } catch (error: unknown) {
      capacity.stop();
      await cleanupObservabilityStartup(authenticator, store);
      throw error;
    }
  }
  const sessions: Map<string, RemoteSession> = new Map<string, RemoteSession>();
  const initializingByTenant: Map<string, number> = new Map<string, number>();
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
    capacity.pruneRateWindows();
    await closeSessions(expired, "Murmur idle-session shutdown failed");
  };

  const handleMcpRequest: (request: Request, observation: RequestObservation) => Promise<Response> =
    async (request: Request, observation: RequestObservation): Promise<Response> => {
      if (!originIsAllowed(request, allowedOrigins)) {
        observation.recordOrigin("rejected");
        return jsonResponse(403, { error: "Origin is not allowed" });
      }
      observation.recordOrigin("allowed");
      const token: string | null = bearerToken(request);
      if (token === null) {
        observation.recordCredential("missing");
        observation.recordAuthentication("invalid");
        return unauthorizedResponse();
      }
      const registeredAdmission: CredentialAdmission | null =
        authenticator.credentialAdmission(token);
      const admittedTenantKey: string | null =
        registeredAdmission === null ? null : registeredAdmission.tenantKey;
      const admissionKey: string =
        registeredAdmission === null
          ? hashTokenSecret(token).toString("base64url")
          : registeredAdmission.key;
      const knownCredential: boolean = registeredAdmission !== null;
      observation.recordCredential(knownCredential ? "known" : "unknown");
      const releaseAuthenticationCapacity: (() => void) | null =
        await capacity.reserveAuthentication(admissionKey, admittedTenantKey, knownCredential);
      if (releaseAuthenticationCapacity === null) {
        observation.recordAuthenticationCapacity("rejected");
        return authenticationCapacityResponse();
      }
      observation.recordAuthenticationCapacity("allowed");
      let principal: HostedPrincipal | null;
      try {
        principal = await authenticator.authenticate(token);
      } catch (error: unknown) {
        observation.recordAuthentication("backend_error");
        observation.recordError(error);
        logSafeError("Murmur authentication backend error", error);
        return jsonResponse(503, { error: "Authentication service unavailable" });
      } finally {
        releaseAuthenticationCapacity();
      }
      if (principal === null) {
        observation.recordAuthentication("invalid");
        return unauthorizedResponse();
      }
      observation.recordAuthentication("authenticated");
      observation.recordPrincipal(principal);

      const principalIdentity: string = authenticator.identity(principal);
      const tenantId: string | null = principal.kind === "tenant" ? principal.tenantId.value : null;
      const isStandaloneStream: boolean = request.method === "GET";
      const releaseResponseCapacity: (() => void) | null = isStandaloneStream
        ? capacity.reserveStream(principalIdentity, tenantId)
        : capacity.reserveRequest(principalIdentity, tenantId);
      if (releaseResponseCapacity === null) {
        if (isStandaloneStream) {
          observation.recordStreamCapacity("rejected");
          return streamCapacityResponse();
        }
        observation.recordRequestCapacity("rejected");
        return jsonResponse(503, { error: "MCP request capacity reached" });
      }
      if (isStandaloneStream) observation.recordStreamCapacity("allowed");
      else observation.recordRequestCapacity("allowed");
      let responseHandedOff: boolean = false;
      try {
        const response: Response = await (async (): Promise<Response> => {
          const now: number = capacity.now();
          await expireIdleSessions(now);
          if (!capacity.rateLimitAllows(principalIdentity)) {
            observation.recordPrincipalRateLimit("rejected");
            return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
                "retry-after": "60",
              },
              status: 429,
            });
          }
          observation.recordPrincipalRateLimit("allowed");
          const tenantRateIdentity: string | null =
            principal.kind === "tenant" ? `tenant-quota:${principal.tenantId.value}` : null;
          if (
            tenantRateIdentity !== null &&
            !capacity.rateLimitAllows(tenantRateIdentity, tenantRateLimitPerMinute)
          ) {
            observation.recordTenantRateLimit("rejected");
            return new Response(JSON.stringify({ error: "Tenant rate limit exceeded" }), {
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
                "retry-after": "60",
              },
              status: 429,
            });
          }
          if (tenantRateIdentity !== null) observation.recordTenantRateLimit("allowed");

          let parsedPostBody: unknown;
          if (request.method === "POST") {
            try {
              parsedPostBody = await parseRequestBody(request, maxRequestBytes);
              observation.recordMcpRequest(mcpRequestMetadata(parsedPostBody));
            } catch (error: unknown) {
              observation.recordError(error);
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
              observation.recordSessionLookup("not_found");
              return jsonResponse(404, { error: "MCP session not found" });
            }
            observation.recordSessionLookup("found");
            observation.recordSession(sessionId);
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
            observation.recordError(error);
            const message: string = error instanceof Error ? error.message : String(error);
            return jsonResponse(400, {
              error: `Invalid Murmur context header: ${message}`,
            });
          }
          if (sessions.size + initializingSessions >= maxSessions) {
            observation.recordSessionCapacity("rejected", "global");
            return jsonResponse(503, { error: "MCP session capacity reached" });
          }
          if (tenantId !== null) {
            const establishedForTenant: number = Array.from(sessions.values()).filter(
              (session: RemoteSession): boolean => session.tenantId === tenantId,
            ).length;
            const initializingForTenant: number = initializingByTenant.get(tenantId) ?? 0;
            if (establishedForTenant + initializingForTenant >= maxSessionsPerTenant) {
              observation.recordSessionCapacity("rejected", "tenant");
              return jsonResponse(503, { error: "Tenant MCP session capacity reached" });
            }
          }
          observation.recordSessionCapacity(
            "allowed",
            tenantId === null ? "global" : "global_and_tenant",
          );

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
            onRepositoryDivergence: (): void => recordRepositoryDivergence(observability),
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
              observation.recordSession(initializedSessionId);
              observation.recordSessionLookup("found");
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
          releaseResponseCapacity,
        );
        responseHandedOff = true;
        return capacityTrackedResponse;
      } finally {
        if (!responseHandedOff) releaseResponseCapacity();
      }
    };

  let bunServer: Bun.Server<undefined>;
  try {
    bunServer = Bun.serve({
      fetch: createHttpRequestHandler(observability, handleMcpRequest),
      hostname,
      port: requestedPort,
    });
  } catch (error: unknown) {
    capacity.stop();
    await cleanupServerStartup(authenticator, store, observability, null);
    throw error;
  }

  const boundPort: number | undefined = bunServer.port;
  if (boundPort === undefined) {
    capacity.stop();
    await cleanupServerStartup(authenticator, store, observability, bunServer);
    throw new Error("The HTTP server did not bind a TCP port");
  }
  const port: number = boundPort;
  const publicHostname: string = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const mcpUrl: URL = new URL(`http://${publicHostname}:${port}${MCP_PATH}`);
  observability.info("service.started", { hostname, port });

  return {
    mcpUrl,
    port,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      capacity.stop();
      const activeSessions: [string, RemoteSession][] = Array.from(sessions.entries());
      await shutdownHttpResources(
        bunServer,
        async (): Promise<void> =>
          await closeSessions(activeSessions, "Murmur active-session shutdown failed"),
        authenticator,
        store,
        observability,
      );
    },
  };
}

if (import.meta.main) {
  startHttpServer()
    .then((server: MurmurHttpServer): void => {
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
