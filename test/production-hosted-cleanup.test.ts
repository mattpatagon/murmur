import { expect, spyOn, test } from "bun:test";
import type { Server } from "bun";

import {
  closeProductionHarnesses,
  type ProductionHarness,
} from "../scripts/lib/production-hosted-harness.js";

type CleanupFixture = {
  readonly endpoint: URL;
  readonly requests: Headers[];
};

async function withFixture(
  reply: (request: Request, index: number) => Response | Promise<Response>,
  operation: (fixture: CleanupFixture) => Promise<void>,
): Promise<void> {
  const requests: Headers[] = [];
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      if (request.method !== "DELETE") return new Response("barrier");
      requests.push(new Headers(request.headers));
      return await reply(request, requests.length - 1);
    },
  });
  try {
    await operation({ endpoint: new URL("/mcp", server.url), requests });
  } finally {
    await server.stop(true);
  }
}

function harnesses(endpoint: URL, count: number): ProductionHarness[] {
  return Array.from(
    { length: count },
    (_value: unknown, index: number): ProductionHarness => ({
      clientName: "codex",
      repositoryName: "fixture/cleanup",
      sessionId: `cleanup-session-${String(index)}`,
      token: "synthetic-cleanup-credential",
      url: endpoint,
    }),
  );
}

function capacityResponse(status: number): Response {
  return Response.json({ error: "Authentication capacity reached" }, { status });
}

test("production session cleanup permits only one DELETE in flight", async (): Promise<void> => {
  let release: (() => void) | undefined;
  const gate: Promise<void> = new Promise((resolve: () => void): void => {
    release = resolve;
  });
  let observed: (() => void) | undefined;
  const firstRequest: Promise<void> = new Promise((resolve: () => void): void => {
    observed = resolve;
  });
  let active: number = 0;
  let maximum: number = 0;
  await withFixture(
    async (): Promise<Response> => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (observed !== undefined) observed();
      await gate;
      active -= 1;
      return Response.json({});
    },
    async (fixture: CleanupFixture): Promise<void> => {
      const cleanup: Promise<void> = closeProductionHarnesses(harnesses(fixture.endpoint, 8));
      try {
        await firstRequest;
        const barrier: Response = await fetch(new URL("/barrier", fixture.endpoint));
        await barrier.text();
      } finally {
        if (release !== undefined) release();
        await cleanup;
      }
      expect(maximum).toBe(1);
      expect(fixture.requests).toHaveLength(8);
      expect(
        fixture.requests.map((request: Headers): string | null => request.get("mcp-session-id")),
      ).toEqual(
        Array.from(
          { length: 8 },
          (_value: unknown, index: number): string => `cleanup-session-${String(index)}`,
        ),
      );
    },
  );
});

test.each([200, 401, 404])(
  "production session cleanup accepts terminal HTTP %i",
  async (status: number): Promise<void> => {
    await withFixture(
      (): Response => new Response("already closed", { status }),
      async (fixture: CleanupFixture): Promise<void> => {
        await closeProductionHarnesses(harnesses(fixture.endpoint, 1));
        expect(fixture.requests).toHaveLength(1);
      },
    );
  },
);

test.each([429, 503])(
  "production session cleanup recovers from authentication HTTP %i",
  async (status: number): Promise<void> => {
    await withFixture(
      (_request: Request, index: number): Response =>
        index === 0 ? capacityResponse(status) : new Response(null, { status: 200 }),
      async (fixture: CleanupFixture): Promise<void> => {
        await closeProductionHarnesses(harnesses(fixture.endpoint, 1));
        expect(fixture.requests).toHaveLength(2);
      },
    );
  },
);

test.each([202, 429, 503])(
  "production session cleanup propagates unrelated HTTP %i and closes remaining sessions",
  async (status: number): Promise<void> => {
    await withFixture(
      (_request: Request, index: number): Response =>
        index === 0
          ? Response.json({ error: "synthetic-private-upstream-error" }, { status })
          : new Response(null, { status: 200 }),
      async (fixture: CleanupFixture): Promise<void> => {
        await expect(closeProductionHarnesses(harnesses(fixture.endpoint, 2))).rejects.toThrow(
          "Production MCP session cleanup failed",
        );
        expect(fixture.requests).toHaveLength(2);
      },
    );
  },
);

test("production session cleanup exhausts six authentication retries", async (): Promise<void> => {
  await withFixture(
    (): Response => capacityResponse(503),
    async (fixture: CleanupFixture): Promise<void> => {
      await expect(closeProductionHarnesses(harnesses(fixture.endpoint, 1))).rejects.toThrow(
        "Production MCP session cleanup failed",
      );
      expect(fixture.requests).toHaveLength(6);
    },
  );
}, 10_000);

test("production session cleanup aborts an in-flight request at its shared deadline", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  const timeout: ReturnType<typeof spyOn<typeof AbortSignal, "timeout">> = spyOn(
    AbortSignal,
    "timeout",
  ).mockImplementation((milliseconds: number): AbortSignal => {
    expect(milliseconds).toBe(20_000);
    return controller.signal;
  });
  try {
    await withFixture(
      (): Response => {
        controller.abort();
        return new Response(null, { status: 200 });
      },
      async (fixture: CleanupFixture): Promise<void> => {
        await expect(closeProductionHarnesses(harnesses(fixture.endpoint, 2))).rejects.toThrow(
          "Production MCP session cleanup failed",
        );
        expect(fixture.requests).toHaveLength(1);
        expect(timeout).toHaveBeenCalledTimes(1);
      },
    );
  } finally {
    timeout.mockRestore();
  }
});
