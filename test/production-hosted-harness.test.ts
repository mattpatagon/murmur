import { expect, test } from "bun:test";
import type { Server } from "bun";
import { z } from "zod";

import {
  connectProductionHarness,
  type ProductionHarness,
} from "../scripts/lib/production-hosted-harness.js";

const SESSION: string = "production-harness-fixture";
const TOKEN: string = "production-harness-synthetic-credential";
const REQUEST_SCHEMA: z.ZodType<{ readonly method: string }> = z.object({
  method: z.string(),
});

type HarnessFixture = {
  readonly endpoint: URL;
  readonly requests: Request[];
  readonly methods: string[];
};

async function withFixture(
  replies: readonly Response[],
  operation: (fixture: HarnessFixture) => Promise<void>,
): Promise<void> {
  const requests: Request[] = [];
  const methods: string[] = [];
  let initializations: number = 0;
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const payload: { readonly method: string } = REQUEST_SCHEMA.parse(await request.json());
      requests.push(request);
      methods.push(payload.method);
      if (payload.method === "initialize") {
        const configured: Response | undefined = replies[initializations];
        initializations += 1;
        if (configured !== undefined) return configured;
        return Response.json(
          { id: 1, jsonrpc: "2.0", result: {} },
          { headers: { "mcp-session-id": SESSION } },
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return Response.json({ error: "Unexpected fixture method" }, { status: 400 });
    },
  });
  try {
    await operation({ endpoint: new URL("/mcp", server.url), requests, methods });
  } finally {
    await server.stop(true);
  }
}

function authenticationCapacity(status: number): Response {
  return Response.json(
    { error: "Authentication capacity reached" },
    { headers: { "retry-after": "1", "cache-control": "no-store" }, status },
  );
}

test.each([429, 503])(
  "production harness retries authentication HTTP %i and initializes the resulting session",
  async (status: number): Promise<void> => {
    await withFixture(
      [authenticationCapacity(status)],
      async (fixture: HarnessFixture): Promise<void> => {
        const harness: ProductionHarness = await connectProductionHarness(
          fixture.endpoint,
          TOKEN,
          "capacity-recovery-fixture",
        );
        expect(harness.sessionId).toBe(SESSION);
        expect(harness.url.href).toBe(fixture.endpoint.href);
        expect(fixture.methods).toEqual(["initialize", "initialize", "notifications/initialized"]);
        const initialized: Request | undefined = fixture.requests.at(-1);
        if (initialized === undefined) throw new Error("Initialized notification was not observed");
        expect(initialized.headers.get("mcp-session-id")).toBe(SESSION);
        expect(initialized.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      },
    );
  },
);

test("production harness does not retry a non-authentication HTTP 429", async (): Promise<void> => {
  await withFixture(
    [Response.json({ error: "MCP request rate limit reached" }, { status: 429 })],
    async (fixture: HarnessFixture): Promise<void> => {
      await expect(
        connectProductionHarness(fixture.endpoint, TOKEN, "unrelated-throttling-fixture"),
      ).rejects.toThrow("Murmur returned HTTP 429");
      expect(fixture.methods).toEqual(["initialize"]);
    },
  );
});

test("production harness exhausts exactly six authentication HTTP 429 attempts", async (): Promise<void> => {
  const replies: Response[] = Array.from(
    { length: 6 },
    (): Response => authenticationCapacity(429),
  );
  await withFixture(replies, async (fixture: HarnessFixture): Promise<void> => {
    await expect(
      connectProductionHarness(fixture.endpoint, TOKEN, "authentication-exhaustion-fixture"),
    ).rejects.toThrow();
    expect(fixture.methods).toEqual(Array.from({ length: 6 }, (): string => "initialize"));
    expect(fixture.requests).toHaveLength(6);
  });
}, 10_000);
