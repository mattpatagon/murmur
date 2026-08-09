import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { TenantId } from "../src/domain/value-objects.js";
import { HostedAuthenticator } from "../src/hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../src/hosted/control-plane.js";
import { credentialAdmissionKey } from "../src/hosted/token-secret.js";
import { startHttpServer, type MurmurHttpServer } from "../src/http-server.js";

const API_TOKEN: string = "test-murmur-api-token";
const JsonRpcEnvelopeSchema: z.ZodObject<{
  result: z.ZodType<unknown>;
}> = z.object({ result: z.unknown() });

function testEnvironment(databasePath: string): NodeJS.ProcessEnv {
  return {
    MURMUR_API_TOKEN: API_TOKEN,
    MURMUR_DB_PATH: databasePath,
    MURMUR_HTTP_HOST: "127.0.0.1",
    PORT: "0",
  };
}

function requestHeaders(sessionId: string | null = null, token: string = API_TOKEN): Headers {
  const headers: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "feature/http-context",
    "X-Murmur-Client": "claude",
    "X-Murmur-Repository": "mattpatagon/murmur",
  });
  if (sessionId !== null) {
    headers.set("Mcp-Session-Id", sessionId);
    headers.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return headers;
}

async function postJsonWithToken(
  url: URL,
  body: Record<string, unknown>,
  token: string,
  sessionId: string | null = null,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: requestHeaders(sessionId, token),
    method: "POST",
  });
}

async function postJson(
  url: URL,
  body: Record<string, unknown>,
  sessionId: string | null,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: requestHeaders(sessionId),
    method: "POST",
  });
}

async function responsePayload(response: Response): Promise<unknown> {
  const text: string = await response.text();
  const contentType: string = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const dataLines: string[] = text
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "));
  const lastLine: string | undefined = dataLines.at(-1);
  if (lastLine === undefined) throw new Error("MCP SSE response did not include a data event");
  return JSON.parse(lastLine.slice("data: ".length));
}

function initializeRequest(id: number, name: string = "remote-test"): Record<string, unknown> {
  return {
    id,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  };
}

class AdmissionTestAuthenticator extends HostedAuthenticator {
  private forgedAuthentications: number;
  private readonly forgedWaiters: Array<() => void>;
  private readonly releaseForgedAuthentication: () => void;
  private readonly forgedAuthenticationReleased: Promise<void>;
  private readonly validToken: string;
  private validTokenActive: boolean;

  public constructor(validToken: string) {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
    this.forgedAuthentications = 0;
    this.forgedWaiters = [];
    this.validToken = validToken;
    this.validTokenActive = true;
    let release: (() => void) | undefined;
    this.forgedAuthenticationReleased = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    if (release === undefined) throw new Error("Forged authentication release was not initialized");
    this.releaseForgedAuthentication = release;
  }

  public override credentialAdmission(token: string): CredentialAdmission | null {
    return this.validTokenActive && token === this.validToken
      ? { key: credentialAdmissionKey(token), tenantKey: "founding-tenant-admission-key" }
      : null;
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    if (token === this.validToken) {
      return {
        kind: "tenant",
        role: "agent",
        tenantId: TenantId.founding(),
        tokenId: "first-use-valid-token",
      };
    }
    this.forgedAuthentications += 1;
    this.forgedWaiters.splice(0).forEach((resolve: () => void): void => {
      resolve();
    });
    await this.forgedAuthenticationReleased;
    return null;
  }

  public releaseForged(): void {
    this.releaseForgedAuthentication();
  }

  public deactivateValidToken(): void {
    this.validTokenActive = false;
  }

  public async waitForForged(count: number): Promise<void> {
    while (this.forgedAuthentications < count) {
      await new Promise<void>((resolve: () => void): void => {
        this.forgedWaiters.push(resolve);
      });
    }
  }
}

async function initializeSession(url: URL): Promise<string> {
  const response: Response = await postJson(url, initializeRequest(1), null);
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await responsePayload(response));
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("MCP initialize response did not include a session ID");
  const initialized: Response = await postJson(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expect(initialized.status).toBe(202);
  return sessionId;
}

test("remote MCP requires a bearer token", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const healthUrl: URL = new URL("/health", server.mcpUrl);
    const healthResponse: Response = await fetch(healthUrl);
    expect(healthResponse.status).toBe(200);
    const response: Response = await fetch(server.mcpUrl, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="murmur"');
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP reserves authentication capacity for a valid first request", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-auth-admission-"));
  const validToken: string = `mur_valid000_${"v".repeat(43)}`;
  const authenticator: AdmissionTestAuthenticator = new AdmissionTestAuthenticator(validToken);
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4",
    },
    { authenticator },
  );
  try {
    const forgedTokens: readonly string[] = [
      `mur_valid000_${"x".repeat(43)}`,
      `mur_forged02_${"x".repeat(43)}`,
      `mur_forged03_${"x".repeat(43)}`,
    ];
    const forgedRequests: Promise<Response>[] = forgedTokens.map(
      async (token: string, index: number): Promise<Response> =>
        await postJsonWithToken(
          server.mcpUrl,
          initializeRequest(20 + index, `forged-${index}`),
          token,
        ),
    );
    await authenticator.waitForForged(3);

    const valid: Response = await postJsonWithToken(
      server.mcpUrl,
      initializeRequest(30, "valid-first-use"),
      validToken,
    );
    expect(valid.status).toBe(200);

    authenticator.releaseForged();
    const forgedResponses: Response[] = await Promise.all(forgedRequests);
    expect(forgedResponses.map((response: Response): number => response.status)).toEqual([
      401, 401, 401,
    ]);
  } finally {
    authenticator.releaseForged();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP does not reserve capacity for a formerly active credential", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-stale-admission-"));
  const validToken: string = `mur_valid000_${"v".repeat(43)}`;
  const authenticator: AdmissionTestAuthenticator = new AdmissionTestAuthenticator(validToken);
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4",
    },
    { authenticator },
  );
  try {
    const initialValid: Response = await postJsonWithToken(
      server.mcpUrl,
      initializeRequest(60, "initial-valid"),
      validToken,
    );
    expect(initialValid.status).toBe(200);
    authenticator.deactivateValidToken();

    const forgedRequests: Promise<Response>[] = ["stale01", "stale02", "stale03"].map(
      async (keyId: string, index: number): Promise<Response> =>
        await postJsonWithToken(
          server.mcpUrl,
          initializeRequest(70 + index, `stale-forged-${index}`),
          `mur_${keyId}_${"z".repeat(43)}`,
        ),
    );
    await authenticator.waitForForged(3);
    const staleValid: Response = await postJsonWithToken(
      server.mcpUrl,
      initializeRequest(80, "stale-valid"),
      validToken,
    );
    expect(staleValid.status).toBe(503);

    authenticator.releaseForged();
    const forgedResponses: Response[] = await Promise.all(forgedRequests);
    expect(forgedResponses.map((response: Response): number => response.status)).toEqual([
      401, 401, 401,
    ]);
  } finally {
    authenticator.releaseForged();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP enforces body and session capacity limits", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-limits-"));
  const environment: NodeJS.ProcessEnv = {
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_MAX_REQUEST_BYTES: "1024",
    MURMUR_MAX_SESSIONS: "1",
  };
  const server: MurmurHttpServer = await startHttpServer(environment);
  try {
    const oversizedInitialization: Response = await postJson(
      server.mcpUrl,
      initializeRequest(1, "x".repeat(2_048)),
      null,
    );
    expect(oversizedInitialization.status).toBe(413);

    const encoder: TextEncoder = new TextEncoder();
    const chunkedBody: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(encoder.encode("{"));
        controller.enqueue(encoder.encode(`"padding":"${"x".repeat(2_048)}"}`));
        controller.close();
      },
    });
    const chunkedHeaders: Headers = requestHeaders();
    chunkedHeaders.set("Connection", "close");
    chunkedHeaders.delete("Content-Length");
    const oversizedChunkedRequest: Response = await fetch(server.mcpUrl, {
      body: chunkedBody,
      headers: chunkedHeaders,
      method: "POST",
    });
    expect(oversizedChunkedRequest.status).toBe(413);

    const [first, second]: [Response, Response] = await Promise.all([
      postJson(server.mcpUrl, initializeRequest(2, "capacity-a"), null),
      postJson(server.mcpUrl, initializeRequest(3, "capacity-b"), null),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 503]);
    const active: Response = first.status === 200 ? first : second;
    const sessionId: string | null = active.headers.get("mcp-session-id");
    if (sessionId === null) throw new Error("Capacity test did not establish a session");

    const oversizedToolCall: Response = await postJson(
      server.mcpUrl,
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "x".repeat(2_048), display_name: "Oversized" },
          name: "register_agent",
        },
      },
      sessionId,
    );
    expect(oversizedToolCall.status).toBe(413);
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP enforces request rate and idle-session limits", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-lifecycle-"));
  const rateLimitedServer: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "rate.db")),
    MURMUR_RATE_LIMIT_PER_MINUTE: "2",
    MURMUR_TENANT_RATE_LIMIT_PER_MINUTE: "10",
  });
  try {
    const sessionId: string = await initializeSession(rateLimitedServer.mcpUrl);
    const limited: Response = await postJson(
      rateLimitedServer.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  } finally {
    await rateLimitedServer.stop();
  }

  const idleServer: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "idle.db")),
    MURMUR_SESSION_IDLE_MS: "25",
  });
  try {
    const sessionId: string = await initializeSession(idleServer.mcpUrl);
    await Bun.sleep(50);
    const expired: Response = await postJson(
      idleServer.mcpUrl,
      { id: 3, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(expired.status).toBe(404);
  } finally {
    await idleServer.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP keeps sessions with active SSE responses alive", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-stream-"));
  const server: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_SESSION_IDLE_MS: "25",
  });
  const streamAbortController: AbortController = new AbortController();
  try {
    const sessionId: string = await initializeSession(server.mcpUrl);
    const streamResponse: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(sessionId),
      signal: streamAbortController.signal,
    });
    expect(streamResponse.status).toBe(200);
    await Bun.sleep(50);
    const active: Response = await postJson(
      server.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(active.status).toBe(200);
  } finally {
    streamAbortController.abort();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP reserves request capacity across long-lived streams", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-capacity-"));
  const server: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1",
  });
  const streamAbortController: AbortController = new AbortController();
  try {
    const sessionId: string = await initializeSession(server.mcpUrl);
    const streamResponse: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(sessionId),
      signal: streamAbortController.signal,
    });
    expect(streamResponse.status).toBe(200);

    const limited: Response = await postJson(
      server.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(limited.status).toBe(503);
    expect(await limited.json()).toEqual({ error: "MCP request capacity reached" });

    streamAbortController.abort();
    await Bun.sleep(25);
    const recovered: Response = await postJson(
      server.mcpUrl,
      { id: 3, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    expect(recovered.status).toBe(200);
  } finally {
    streamAbortController.abort();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP error responses never expose sentinel content", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-errors-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  const sentinel: string = "HTTP_ERROR_SENTINEL";
  const originalIdentity: HostedAuthenticator["identity"] = HostedAuthenticator.prototype.identity;
  const originalConsoleError: typeof console.error = console.error;
  const logged: string[] = [];
  try {
    const unauthorized: Response = await fetch(server.mcpUrl, {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    const forbiddenHeaders: Headers = requestHeaders();
    forbiddenHeaders.set("Origin", "https://untrusted.example");
    const forbidden: Response = await fetch(server.mcpUrl, {
      body: "{}",
      headers: forbiddenHeaders,
      method: "POST",
    });
    expect(forbidden.status).toBe(403);

    const missingSession: Response = await postJson(
      server.mcpUrl,
      { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
      "unknown-session",
    );
    expect(missingSession.status).toBe(404);

    const invalidJson: Response = await fetch(server.mcpUrl, {
      body: "{not-json",
      headers: requestHeaders(),
      method: "POST",
    });
    expect(invalidJson.status).toBe(400);

    console.error = (...values: unknown[]): void => {
      logged.push(values.map(String).join(" "));
    };
    HostedAuthenticator.prototype.identity = (): string => {
      throw new Error(`failed via postgresql://murmur:${sentinel}@database.example/murmur`);
    };
    const internal: Response = await postJson(
      server.mcpUrl,
      {
        id: 2,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "error-test", version: "1.0.0" },
          protocolVersion: LATEST_PROTOCOL_VERSION,
        },
      },
      null,
    );
    expect(internal.status).toBe(500);
    const responseText: string = await internal.text();
    expect(responseText).toContain("Internal server error");
    expect(responseText).not.toContain(sentinel);
    expect(logged.join("\n")).not.toContain(sentinel);
  } finally {
    HostedAuthenticator.prototype.identity = originalIdentity;
    console.error = originalConsoleError;
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP serves tools with repository context", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const sessionId: string = await initializeSession(server.mcpUrl);
    const streamAbortController: AbortController = new AbortController();
    const streamResponse: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(sessionId),
      signal: streamAbortController.signal,
    });
    expect(streamResponse.status).toBe(200);
    const streamBody: ReadableStream<Uint8Array> | null = streamResponse.body;
    if (streamBody === null) throw new Error("MCP SSE response did not include a body");
    const streamReader: ReadableStreamDefaultReader<Uint8Array> = streamBody.getReader();
    const firstChunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
      await Promise.race([
        streamReader.read(),
        Bun.sleep(3_000).then((): never => {
          throw new Error("MCP SSE keepalive timed out");
        }),
      ]);
    if (firstChunk.done || firstChunk.value === undefined) {
      throw new Error("MCP SSE stream closed before its first keepalive");
    }
    expect(new TextDecoder().decode(firstChunk.value)).toContain(": keepalive");
    streamAbortController.abort();

    const toolsResponse: Response = await postJson(
      server.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId,
    );
    const toolsPayload: unknown = await responsePayload(toolsResponse);
    expect(JSON.stringify(toolsPayload)).toContain("send_message");

    const calls: readonly Record<string, unknown>[] = [
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "remote-a", display_name: "Remote A" },
          name: "register_agent",
        },
      },
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: "remote-b", display_name: "Remote B" },
          name: "register_agent",
        },
      },
    ];
    let callIndex: number = 0;
    while (callIndex < calls.length) {
      const call: Record<string, unknown> | undefined = calls[callIndex];
      if (call === undefined) throw new Error("Remote MCP call disappeared during iteration");
      const response: Response = await postJson(server.mcpUrl, call, sessionId);
      expect(response.status).toBe(200);
      callIndex += 1;
    }

    const sentResponse: Response = await postJson(
      server.mcpUrl,
      {
        id: 5,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            content: "hello over HTTP",
            recipient_id: "remote-b",
            sender_id: "remote-a",
          },
          name: "send_message",
        },
      },
      sessionId,
    );
    const sentEnvelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
      await responsePayload(sentResponse),
    );
    const sentResult: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(
      sentEnvelope.result,
    );
    expect(sentResult.isError).not.toBe(true);
    expect(JSON.stringify(sentResult.structuredContent)).toContain("mattpatagon/murmur");
    expect(JSON.stringify(sentResult.structuredContent)).toContain("feature/http-context");
    expect(JSON.stringify(sentResult.structuredContent)).toContain('"client":"claude"');
    expect(JSON.stringify(sentResult.structuredContent)).toContain("created_at");
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
