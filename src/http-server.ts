#!/usr/bin/env bun

import { randomUUID, timingSafeEqual } from "node:crypto";
import process from "node:process";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { AgentClient, BranchName, RepositoryName } from "./domain/value-objects.js";
import { MurmurApplication } from "./mcp/murmur-application.js";
import { createStore } from "./storage/create-store.js";
import type { MessageStore } from "./storage/message-store.js";

const DEFAULT_PORT: number = 8080;
const HEALTH_PATH: string = "/health";
const MCP_PATH: string = "/mcp";
const BRANCH_HEADER: string = "x-murmur-branch";
const CLIENT_HEADER: string = "x-murmur-client";
const REPOSITORY_HEADER: string = "x-murmur-repository";
const SSE_KEEP_ALIVE_MS: number = 1_000;

type RemoteSession = {
  readonly application: MurmurApplication;
  readonly transport: WebStandardStreamableHTTPServerTransport;
};

export type MurmurHttpServer = {
  readonly mcpUrl: URL;
  readonly port: number;
  stop(): Promise<void>;
};

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value: string | undefined = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for the remote MCP server`);
  }
  return value;
}

function parsePort(environment: NodeJS.ProcessEnv): number {
  const configured: string | undefined = environment["PORT"];
  if (configured === undefined || configured === "") return DEFAULT_PORT;
  return z.coerce.number().int().min(0).max(65_535).parse(configured);
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

function secureTokenEquals(presented: string, expected: string): boolean {
  const presentedBytes: Buffer = Buffer.from(presented, "utf8");
  const expectedBytes: Buffer = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}

function bearerToken(request: Request): string | null {
  const authorization: string | null = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token: string = authorization.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

function isAuthorized(request: Request, apiToken: string): boolean {
  const token: string | null = bearerToken(request);
  return token !== null && secureTokenEquals(token, apiToken);
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
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

async function parseRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch (error: unknown) {
    throw new Error("The MCP request body must be valid JSON", { cause: error });
  }
}

export async function startHttpServer(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MurmurHttpServer> {
  const apiToken: string = requiredEnvironmentValue(environment, "MURMUR_API_TOKEN");
  const allowedOrigins: ReadonlySet<string> = parseAllowedOrigins(environment);
  const hostname: string = environment["MURMUR_HTTP_HOST"] ?? "0.0.0.0";
  const requestedPort: number = parsePort(environment);
  const store: MessageStore = await createStore(environment);
  const sessions: Map<string, RemoteSession> = new Map<string, RemoteSession>();
  let stopped: boolean = false;

  const handleMcpRequest: (request: Request) => Promise<Response> = async (
    request: Request,
  ): Promise<Response> => {
    if (!isAuthorized(request, apiToken)) return unauthorizedResponse();
    if (!originIsAllowed(request, allowedOrigins)) {
      return jsonResponse(403, { error: "Origin is not allowed" });
    }

    const sessionId: string | null = requestSessionId(request);
    if (sessionId !== null) {
      const session: RemoteSession | undefined = sessions.get(sessionId);
      if (session === undefined) return jsonResponse(404, { error: "MCP session not found" });
      return await session.transport.handleRequest(request);
    }

    if (request.method !== "POST") {
      return jsonResponse(400, { error: "Mcp-Session-Id header is required" });
    }

    let body: unknown;
    try {
      body = await parseRequestBody(request);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      return jsonResponse(400, { error: message });
    }
    if (!isInitializeRequest(body)) {
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
      return jsonResponse(400, { error: `Invalid Murmur context header: ${message}` });
    }

    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        keepAliveMs: SSE_KEEP_ALIVE_MS,
        sessionIdGenerator: randomUUID,
      });
    const application: MurmurApplication = new MurmurApplication({
      branchName,
      client,
      closeStoreOnClose: false,
      repositoryName,
      store,
    });
    const session: RemoteSession = { application, transport };
    transport.onclose = (): void => {
      const closedSessionId: string | undefined = transport.sessionId;
      if (closedSessionId !== undefined) sessions.delete(closedSessionId);
    };
    await application.server.connect(transport);
    const response: Response = await transport.handleRequest(request, { parsedBody: body });
    const initializedSessionId: string | undefined = transport.sessionId;
    if (initializedSessionId === undefined) {
      await application.close();
    } else {
      sessions.set(initializedSessionId, session);
    }
    return response;
  };

  const bunServer: Bun.Server<undefined> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      const url: URL = new URL(request.url);
      if (url.pathname === "/" || url.pathname === HEALTH_PATH) {
        if (request.method !== "GET") {
          return new Response(null, { headers: { allow: "GET" }, status: 405 });
        }
        return jsonResponse(200, { service: "murmur", status: "ok" });
      }
      if (url.pathname !== MCP_PATH) return jsonResponse(404, { error: "Not found" });
      return await handleMcpRequest(request);
    },
    hostname,
    port: requestedPort,
  });

  const boundPort: number | undefined = bunServer.port;
  if (boundPort === undefined) {
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
      const activeSessions: RemoteSession[] = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(
        activeSessions.map(
          async (activeSession: RemoteSession): Promise<void> =>
            await activeSession.application.close(),
        ),
      );
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
        void shutdown();
      });
      process.once("SIGTERM", (): void => {
        void shutdown();
      });
    })
    .catch((error: unknown): void => {
      console.error(error);
      process.exitCode = 1;
    });
}
