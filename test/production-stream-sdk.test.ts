import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { PRODUCTION_STREAM_CLOCK, streamDeadline } from "../scripts/lib/production-stream-io.js";
import { ProductionStreamAgent } from "../scripts/lib/production-stream-session.js";
import { AgentClient, BranchName, RepositoryName } from "../src/domain/value-objects.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

test("real SDK transport reconnects once on the original session, pings without reinitializing, then proves SQLite inbox delivery", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
  const application: MurmurApplication = new MurmurApplication({
    store,
    closeStoreOnClose: false,
    branchName: BranchName.parse("production-stream"),
    client: AgentClient.parse("codex"),
    repositoryName: RepositoryName.parse("canary/production-stream"),
  });
  const server: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => "10000000-0000-4000-8000-000000000001",
      enableJsonResponse: true,
    });
  await application.server.connect(server);
  let initialized: number = 0;
  let pings: number = 0;
  let gets: number = 0;
  let replacementReady: () => void = (): void => {};
  const replacement: Promise<void> = new Promise<void>((resolve: () => void): void => {
    replacementReady = resolve;
  });
  const agent: ProductionStreamAgent = new ProductionStreamAgent(
    new URL("https://observer.invalid/mcp"),
    "private-test-agent-token",
    {
      clock: PRODUCTION_STREAM_CLOCK,
      fetch: async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const request: Request = new Request(url, init);
        expect(request.headers.get("authorization")).toBe("Bearer private-test-agent-token");
        if (request.method === "POST") {
          const value: unknown = await request.clone().json();
          const body: { readonly method?: string | undefined } = z
            .object({ method: z.string().optional() })
            .parse(value);
          if (body.method === "initialize") initialized += 1;
          if (body.method === "ping") pings += 1;
        }
        const response: Response = await server.handleRequest(request);
        const headers: Headers = new Headers(response.headers);
        headers.set("x-request-id", randomUUID());
        if (request.method === "GET" && response.status === 200) {
          gets += 1;
          expect(request.headers.get("mcp-session-id")).toBe(
            "10000000-0000-4000-8000-000000000001",
          );
          if (gets === 2) replacementReady();
        }
        return new Response(response.body, { status: response.status, headers });
      },
    },
    0,
  );
  try {
    await streamDeadline(async (signal: AbortSignal): Promise<void> => {
      await agent.start(signal);
      await agent.subscribe(signal);
      await agent.keepAlive(signal);
      expect(pings).toBe(1);
      expect(initialized).toBe(1);
      expect(gets).toBe(1);
      server.closeStandaloneSSEStream();
      await replacement;
      await agent.keepAlive(signal);
      await agent.proveDelivery(signal);
      expect(agent.snapshot().successfulGets).toBe(2);
      expect(agent.snapshot().successfulInitializations).toBe(1);
      expect(agent.snapshot().invalid).toBe(false);
      expect(initialized).toBe(1);
      expect(pings).toBe(2);
    }, 5_000);
  } finally {
    await streamDeadline(
      async (signal: AbortSignal): Promise<void> => await agent.close(signal),
      5_000,
    );
    try {
      await application.close();
    } finally {
      store.close();
    }
  }
});
