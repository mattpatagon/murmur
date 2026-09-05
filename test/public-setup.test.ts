import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { BoundedHttpClientTransport } from "../src/e2ee/bounded-http-transport.js";
import { createHttpRequestHandler } from "../src/http/http-router.js";
import { createPublicSetupHandler, PUBLIC_SETUP_PATH } from "../src/http/public-setup.js";
import { SetupGuideOutputSchema } from "../src/mcp/murmur-setup-guide.js";
import {
  publicSetupHarness,
  type SetupHarness,
  setupRequest,
} from "./support/public-setup-harness.js";

test("an unauthenticated MCP client gets setup instructions through the real router without auth or storage", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  let authenticatedCalls: number = 0;
  const handler: ReturnType<typeof createHttpRequestHandler> = createHttpRequestHandler(
    fixture.observability,
    async (): Promise<Response> => {
      authenticatedCalls += 1;
      throw new Error("Authenticated storage must not be consulted");
    },
    null,
    null,
    null,
    undefined,
    async (request: Request): Promise<Response> => await fixture.handle(request),
  );
  const server: Bun.Server<undefined> = Bun.serve({
    fetch: handler,
    hostname: "127.0.0.1",
    port: 0,
  });
  const client: Client = new Client({ name: "first-install-client", version: "1.0.0" });
  try {
    const url: URL = new URL(PUBLIC_SETUP_PATH, server.url);
    await client.connect(new BoundedHttpClientTransport(url, new Headers()));
    expect((await client.listTools()).tools.map((tool: Tool): string => tool.name)).toEqual([
      "get_setup_guide",
    ]);
    const output: ReturnType<typeof SetupGuideOutputSchema.parse> = SetupGuideOutputSchema.parse(
      (await client.callTool({ name: "get_setup_guide" }, CallToolResultSchema)).structuredContent,
    );
    expect(output.available_tools).toEqual(["get_setup_guide"]);
    expect(
      output.sections.map((section: (typeof output.sections)[number]): string => section.topic),
    ).toContain("hooks");
    expect(JSON.stringify(output)).toContain("signup");
    for (const name of [
      "create_access_token",
      "set_orchestrator_policy",
      "get_messages",
      "send_message",
      "e2ee_local_export_public",
    ]) {
      const forbidden: ReturnType<typeof CallToolResultSchema.parse> = CallToolResultSchema.parse(
        await client.callTool({ name, arguments: {} }, CallToolResultSchema),
      );
      expect(forbidden.isError).toBe(true);
      expect(JSON.stringify(forbidden)).toContain("Unknown setup tool");
    }
    expect(
      (
        await client.callTool(
          { name: "get_setup_guide", arguments: { topic: "invalid" } },
          CallToolResultSchema,
        )
      ).isError,
    ).toBe(true);
    expect(authenticatedCalls).toBe(0);
    const unknown: Response = await fetch(new URL("/setup/mcp/extra", server.url));
    expect(unknown.status).toBe(404);
    await unknown.arrayBuffer();
    expect(authenticatedCalls).toBe(0);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.observability.shutdown();
  }
});

test("setup restricts origin, method and media type before consuming request capacity", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  try {
    expect(
      (await fixture.handle(setupRequest({}, { origin: "https://untrusted.example" }))).status,
    ).toBe(403);
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const response: Response = await fixture.handle(
        new Request(`http://localhost${PUBLIC_SETUP_PATH}`, { method }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await fixture.handle(setupRequest({}, { "content-type": "text/plain" }))).status).toBe(
      415,
    );
    expect(
      (
        await fixture.handle(
          new Request(`http://localhost${PUBLIC_SETUP_PATH}`, { method: "POST" }),
        )
      ).status,
    ).toBe(415);
    const allowed: Response = await fixture.handle(
      setupRequest(undefined, {
        "content-type": "Application/JSON; charset=utf-8",
        origin: "https://approved.example",
      }),
    );
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
    expect(fixture.time.pending()).toBe(0);
    for (const timeout of [0, -1, 5001, Number.NaN, 1.5]) {
      expect(
        (): ReturnType<typeof createPublicSetupHandler> =>
          createPublicSetupHandler({
            allowedOrigins: new Set<string>(),
            bodyTimeoutMs: timeout,
            capacity: fixture.capacity,
          }),
      ).toThrow("deadline");
    }
  } finally {
    await fixture.observability.shutdown();
  }
});

test("setup keeps capacity through response consumption and leaves one authenticated slot available", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  try {
    const pending: Response = await fixture.handle(setupRequest());
    expect(pending.status).toBe(200);
    expect((await fixture.handle(setupRequest())).status).toBe(503);
    const authenticated: (() => void) | null = fixture.capacity.reserveRequest(
      "authenticated",
      "tenant",
    );
    expect(authenticated).not.toBeNull();
    if (authenticated === null) throw new Error("Expected reserved authenticated slot");
    expect(fixture.capacity.reserveRequest("other", "other-tenant")).toBeNull();
    authenticated();
    await pending.arrayBuffer();
    const retry: Response = await fixture.handle(setupRequest());
    expect(retry.status).toBe(200);
    if (retry.body === null) throw new Error("Expected setup response body");
    await retry.body.cancel();
    const expires: Response = await fixture.handle(setupRequest());
    expect(expires.status).toBe(200);
    fixture.time.advance(30_000);
    await expect((async (): Promise<ArrayBuffer> => await expires.arrayBuffer())()).rejects.toThrow(
      "deadline",
    );
    const recovered: Response = await fixture.handle(setupRequest());
    expect(recovered.status).toBe(200);
    await recovered.arrayBuffer();
    expect(fixture.time.pending()).toBe(0);
  } finally {
    await fixture.observability.shutdown();
  }
});

test("setup rejects invalid JSON RPC and arguments without returning supplied private input", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  const marker: string = "private-request-fixture";
  try {
    for (const invalid of [
      null,
      [],
      [
        { id: 1, jsonrpc: "2.0", method: "tools/call", params: { name: "get_setup_guide" } },
        { id: 2, jsonrpc: "2.0", method: "tools/call", params: { name: "get_setup_guide" } },
      ],
      { invalid: marker },
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "get_setup_guide", arguments: { extra: marker } },
      },
    ]) {
      const response: Response = await fixture.handle(setupRequest(invalid));
      const text: string = await response.text();
      expect(response.status === 400 || text.includes('"isError":true')).toBe(true);
      expect(text).not.toContain(marker);
    }
    const resources: Response = await fixture.handle(
      setupRequest({ id: 1, jsonrpc: "2.0", method: "resources/list", params: {} }),
    );
    expect(await resources.text()).toContain("-32601");
  } finally {
    await fixture.observability.shutdown();
  }
});

test("setup has a fixed bounded public rate window that resets without consuming authentication slots", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  try {
    for (let index: number = 0; index < 600; index += 1)
      expect(fixture.capacity.rateLimitAllows("public-setup", 600)).toBe(true);
    const limited: Response = await fixture.handle(setupRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await limited.arrayBuffer();
    fixture.time.advance(60_000);
    const recovered: Response = await fixture.handle(setupRequest());
    expect(recovered.status).toBe(200);
    await recovered.arrayBuffer();
  } finally {
    await fixture.observability.shutdown();
  }
});
