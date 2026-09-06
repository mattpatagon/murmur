import { expect, test } from "bun:test";

import {
  E2eeHttpRemoteClient,
  type E2eeHttpRemoteClientConfig,
} from "../src/e2ee/http-remote-client.js";
import type { E2eeCapabilityOutput } from "../src/e2ee/wire-tools.js";

const CONFIG: E2eeHttpRemoteClientConfig = {
  branch: "feature/e2ee",
  client: "opencode",
  endpoint: "http://127.0.0.1:1/mcp",
  repository: "mattpatagon/murmur",
  token: "test-access-token",
};
const CAPABILITY: E2eeCapabilityOutput = {
  caller_authority: "peer",
  max_ciphertext_bytes: 524_304,
  max_one_time_prekeys: 20,
  protocol: "murmur-e2ee-v1",
  state: "enforced",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  wire_version: 1,
};

test("rejects a noncanonical client before connecting", async (): Promise<void> => {
  await expect(E2eeHttpRemoteClient.connect({ ...CONFIG, client: "OpenCode" })).rejects.toThrow();
});

function toolOutput(output: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ text: JSON.stringify(output), type: "text" }],
    structuredContent: output,
  };
}

test("connects over bounded Streamable HTTP with authenticated project context", async (): Promise<void> => {
  const requests: Request[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      requests.push(request.clone());
      const input: unknown = await request.json();
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
      const method: unknown = Reflect.get(input, "method");
      const id: unknown = Reflect.get(input, "id");
      if (method === "initialize" && (typeof id === "number" || typeof id === "string")) {
        return Response.json(
          {
            id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "test-murmur", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": "bounded-session" } },
        );
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/call" && (typeof id === "number" || typeof id === "string")) {
        const result: Record<string, unknown> = toolOutput(CAPABILITY);
        const event: string = `event: message\ndata: ${JSON.stringify({ id, jsonrpc: "2.0", result })}\n\n`;
        return new Response(event, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "unexpected" }, { status: 400 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const client: E2eeHttpRemoteClient = await E2eeHttpRemoteClient.connect({
    ...CONFIG,
    endpoint: `http://127.0.0.1:${server.port}/mcp`,
  });
  try {
    expect(await client.capability()).toEqual(CAPABILITY);
    expect(requests).toHaveLength(3);
    const callRequest: Request | undefined = requests[2];
    if (callRequest === undefined) throw new Error("Tool request was not captured");
    const callHeaders: Headers = callRequest.headers;
    expect(callHeaders.get("authorization")).toBe("Bearer test-access-token");
    expect(callHeaders.get("x-murmur-repository")).toBe("mattpatagon/murmur");
    expect(callHeaders.get("x-murmur-branch")).toBe("feature/e2ee");
    expect(callHeaders.get("x-murmur-client")).toBe("opencode");
    expect(callHeaders.get("mcp-session-id")).toBe("bounded-session");
    expect(callHeaders.get("mcp-protocol-version")).toBe("2025-11-25");
  } finally {
    await client.close();
    server.stop(true);
  }
});

test("rejects an unbounded or non-visible hosted session identifier", async (): Promise<void> => {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      const input: unknown = await request.json();
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
      const id: unknown = Reflect.get(input, "id");
      return Response.json(
        {
          id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: "2025-11-25",
            serverInfo: { name: "test-murmur", version: "1.0.0" },
          },
        },
        { headers: { "mcp-session-id": "x".repeat(129) } },
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    await expect(
      E2eeHttpRemoteClient.connect({
        ...CONFIG,
        endpoint: `http://127.0.0.1:${server.port}/mcp`,
      }),
    ).rejects.toThrow("encrypted Murmur service connection failed");
  } finally {
    server.stop(true);
  }
});

test("rejects insecure external endpoints and unsafe configuration before connecting", async (): Promise<void> => {
  await expect(E2eeHttpRemoteClient.connect({ ...CONFIG, endpoint: "not a URL" })).rejects.toThrow(
    "endpoint URL is invalid",
  );
  await expect(
    E2eeHttpRemoteClient.connect({ ...CONFIG, endpoint: "http://example.com/mcp" }),
  ).rejects.toThrow("must use HTTPS outside loopback");
  await expect(
    E2eeHttpRemoteClient.connect({ ...CONFIG, endpoint: "https://user@example.com/mcp" }),
  ).rejects.toThrow("may not contain credentials or parameters");
  await expect(E2eeHttpRemoteClient.connect({ ...CONFIG, token: "bad token" })).rejects.toThrow(
    "access token is invalid",
  );
});
