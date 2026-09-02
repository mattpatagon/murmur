import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { HostedAuthenticator } from "../src/hosted/authenticator.js";
import type { TimeSource } from "../src/http/http-capacity.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  AdmissionTestAuthenticator,
  initializeRequest,
  initializeSession,
  postJson,
  postJsonWithToken,
  requestHeaders,
  TenantBurstAuthenticator,
  testEnvironment,
} from "./support/http-mcp-harness.js";

class ManualTimeSource implements TimeSource {
  private current: number = 0;

  public advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  public now(): number {
    return this.current;
  }

  public schedule(_milliseconds: number, _wake: () => void): () => void {
    return (): void => undefined;
  }
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
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="murmur", resource_metadata="${server.mcpUrl.origin}/.well-known/oauth-protected-resource/mcp", scope="murmur"`,
    );
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

test("remote MCP queues a recognized tenant authentication burst", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-auth-burst-"));
  const validTokens: readonly string[] = [
    "burst0001",
    "burst0002",
    "burst0003",
    "burst0004",
    "burst0005",
  ].map((keyId: string): string => `mur_${keyId}_${"v".repeat(43)}`);
  const authenticator: TenantBurstAuthenticator = new TenantBurstAuthenticator(validTokens);
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_AUTHENTICATION_WAIT_MS: "1000",
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4",
    },
    { authenticator },
  );
  try {
    let completed: number = 0;
    const requests: Promise<Response>[] = validTokens.map(
      async (token: string, index: number): Promise<Response> => {
        const response: Response = await postJsonWithToken(
          server.mcpUrl,
          initializeRequest(90 + index, `burst-${index}`),
          token,
        );
        completed += 1;
        return response;
      },
    );
    await authenticator.waitForActive(2);
    await Bun.sleep(50);
    expect(completed).toBe(0);
    authenticator.release();
    const responses: Response[] = await Promise.all(requests);
    expect(responses.map((response: Response): number => response.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
  } finally {
    authenticator.release();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("remote MCP releases recognized authentication queue capacity after timeout", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-auth-timeout-"));
  const validTokens: readonly string[] = ["timeout01", "timeout02", "timeout03", "timeout04"].map(
    (keyId: string): string => `mur_${keyId}_${"t".repeat(43)}`,
  );
  const authenticator: TenantBurstAuthenticator = new TenantBurstAuthenticator(validTokens);
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_AUTHENTICATION_WAIT_MS: "100",
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4",
      MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT: "1",
    },
    { authenticator },
  );
  try {
    const activeRequests: Promise<Response>[] = validTokens
      .slice(0, 2)
      .map(
        async (token: string, index: number): Promise<Response> =>
          await postJsonWithToken(
            server.mcpUrl,
            initializeRequest(120 + index, `timeout-active-${index}`),
            token,
          ),
      );
    await authenticator.waitForActive(2);

    const timedOut: Response = await postJsonWithToken(
      server.mcpUrl,
      initializeRequest(122, "timeout-waiter"),
      validTokens[2] ?? "",
    );
    expect(timedOut.status).toBe(503);
    expect(timedOut.headers.get("retry-after")).toBe("1");

    let replacementCompleted: boolean = false;
    const replacement: Promise<Response> = postJsonWithToken(
      server.mcpUrl,
      initializeRequest(123, "replacement-waiter"),
      validTokens[3] ?? "",
    ).then((response: Response): Response => {
      replacementCompleted = true;
      return response;
    });
    await Bun.sleep(25);
    expect(replacementCompleted).toBe(false);
    authenticator.release();
    expect((await replacement).status).toBe(200);
    expect(
      (await Promise.all(activeRequests)).map((response: Response): number => response.status),
    ).toEqual([200, 200]);
  } finally {
    authenticator.release();
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
    expect(staleValid.headers.get("retry-after")).toBe("1");

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

  const idleTime: ManualTimeSource = new ManualTimeSource();
  const idleServer: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "idle.db")),
      MURMUR_SESSION_IDLE_MS: "25",
    },
    { timeSource: idleTime },
  );
  try {
    const sessionId: string = await initializeSession(idleServer.mcpUrl);
    idleTime.advance(25);
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
  const time: ManualTimeSource = new ManualTimeSource();
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_SESSION_IDLE_MS: "25",
    },
    { timeSource: time },
  );
  const streamAbortController: AbortController = new AbortController();
  try {
    const sessionId: string = await initializeSession(server.mcpUrl);
    const streamResponse: Response = await fetch(server.mcpUrl, {
      headers: requestHeaders(sessionId),
      signal: streamAbortController.signal,
    });
    expect(streamResponse.status).toBe(200);
    time.advance(25);
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
      const databaseUrl: URL = new URL("postgresql://database.example/murmur");
      databaseUrl.username = "murmur";
      databaseUrl.password = sentinel;
      throw new Error(`failed via ${databaseUrl.toString()}`);
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
