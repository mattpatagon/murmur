import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import type { Agent, GetMessagesQuery, Message } from "../src/domain/models.js";
import { Sequence } from "../src/domain/value-objects.js";
import {
  createHostedMurmurApplication,
  type HostedApplicationRequest,
} from "../src/http/murmur-application-factory.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import type { MessageStore } from "../src/storage/message-store.js";
import {
  initializeRequest,
  postJson,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

type Gate = { readonly promise: Promise<void>; readonly resolve: () => void };
type Method = "resources/read" | "resources/subscribe" | "tools/call";

class BlockedWork {
  public readonly entered: Gate = Promise.withResolvers<void>();
  public readonly released: Gate = Promise.withResolvers<void>();
  public readonly finished: Gate = Promise.withResolvers<void>();
  public starts: number = 0;
  public pending: number = 0;

  private async run(): Promise<void> {
    this.starts += 1;
    this.pending += 1;
    this.entered.resolve();
    try {
      await this.released.promise;
    } finally {
      this.pending -= 1;
      this.finished.resolve();
    }
  }

  public wrap(store: MessageStore): MessageStore {
    const wrapped: MessageStore = new Proxy<MessageStore>(store, {
      get: (target: MessageStore, key: string | symbol): unknown => {
        if (key === "scope") return (): MessageStore => wrapped;
        if (key === "getMessages") {
          return async (_query: GetMessagesQuery): Promise<readonly Message[]> => {
            await this.run();
            return [];
          };
        }
        if (key === "getAgent") {
          return async (): Promise<Agent | null> => {
            await this.run();
            return null;
          };
        }
        if (key === "getInboxVersion") return (): Sequence => Sequence.zero();
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return wrapped;
  }
}

function workRequest(id: number | string, method: Method): Record<string, unknown> {
  return {
    id,
    jsonrpc: "2.0",
    method,
    params:
      method === "tools/call"
        ? { name: "get_messages", arguments: { agent_id: "processing-probe" } }
        : { uri: "murmur://inbox/processing-probe" },
  };
}

async function initialize(server: MurmurHttpServer, id: number): Promise<string> {
  const response: Response = await postJson(server.mcpUrl, initializeRequest(id), null);
  expect(response.status).toBe(200);
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Initialized session is missing");
  await responsePayload(response);
  const initialized: Response = await postJson(
    server.mcpUrl,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expect(initialized.status).toBe(202);
  await initialized.text();
  return sessionId;
}

async function awaitResponseRelease(server: MurmurHttpServer, sessionId: string): Promise<void> {
  // SDK ping is a control handler: the round trip observes HTTP cancellation without starting work.
  for (let attempt: number = 0; attempt < 50; attempt += 1) {
    const response: Response = await postJson(
      server.mcpUrl,
      { id: 1000 + attempt, jsonrpc: "2.0", method: "ping" },
      sessionId,
    );
    if (response.status === 200) {
      await responsePayload(response);
      return;
    }
    expect(response.status).toBe(503);
    await response.text();
    await setImmediate();
  }
  throw new Error("Canceled HTTP response did not release its response slot");
}

const SCENARIOS: readonly { readonly limit: string; readonly method: Method }[] = [
  { limit: "MURMUR_MAX_ACTIVE_REQUESTS", method: "resources/read" },
  { limit: "MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL", method: "tools/call" },
  { limit: "MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT", method: "resources/subscribe" },
];

for (const scenario of SCENARIOS) {
  test(`${scenario.limit} retains canceled ${scenario.method} work across session close`, async (): Promise<void> => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-http-processing-"));
    try {
      const work: BlockedWork = new BlockedWork();
      const server: MurmurHttpServer = await startHttpServer(
        {
          ...testEnvironment(join(directory, "messages.db")),
          MURMUR_MAX_ACTIVE_REQUESTS: "8",
          MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "8",
          MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "8",
          [scenario.limit]: "1",
        },
        {
          applicationFactory: async (
            request: HostedApplicationRequest,
          ): Promise<MurmurApplication> =>
            await createHostedMurmurApplication({ ...request, store: work.wrap(request.store) }),
        },
      );
      const cancellation: AbortController = new AbortController();
      let client: Promise<void> = Promise.resolve();
      try {
        const firstSession: string = await initialize(server, 1);
        const otherSession: string = await initialize(server, 2);
        client = fetch(server.mcpUrl, {
          body: JSON.stringify(workRequest(7, scenario.method)),
          headers: requestHeaders(firstSession),
          method: "POST",
          signal: cancellation.signal,
        })
          .then(async (response: Response): Promise<void> => {
            await response.text();
          })
          .catch((error: unknown): void => {
            if (!(error instanceof Error) || error.name !== "AbortError") throw error;
          });
        await work.entered.promise;
        cancellation.abort();
        await client;
        await awaitResponseRelease(server, firstSession);
        const canceled: Response = await postJson(
          server.mcpUrl,
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
          firstSession,
        );
        expect(canceled.status).toBe(202);
        await canceled.text();
        await awaitResponseRelease(server, firstSession);
        expect(work.pending).toBe(1);
        const closed: Response = await fetch(server.mcpUrl, {
          headers: requestHeaders(firstSession),
          method: "DELETE",
        });
        expect(closed.status).toBe(200);
        await closed.text();
        await awaitResponseRelease(server, otherSession);
        for (const id of [50, "50", 51, "51"]) {
          const rejected: Response = await postJson(
            server.mcpUrl,
            workRequest(id, scenario.method),
            otherSession,
          );
          expect(rejected.status).toBe(200);
          expect(await responsePayload(rejected)).toEqual({
            id,
            jsonrpc: "2.0",
            error: {
              code: -32003,
              message: "MCP error -32003: MCP processing capacity reached; retry later.",
              data: { retryable: true, retry_after_ms: 1000 },
            },
          });
          expect(work.starts).toBe(1);
          expect(work.pending).toBe(1);
        }
        work.released.resolve();
        await work.finished.promise;
        await awaitResponseRelease(server, otherSession);
        const recovered: Response = await postJson(
          server.mcpUrl,
          workRequest(90, "resources/read"),
          otherSession,
        );
        expect(recovered.status).toBe(200);
        expect(await responsePayload(recovered)).toMatchObject({
          id: 90,
          result: {
            contents: [{ uri: "murmur://inbox/processing-probe", mimeType: "application/json" }],
          },
        });
        expect(work.starts).toBe(2);
        expect(work.pending).toBe(0);
      } finally {
        cancellation.abort();
        work.released.resolve();
        await client;
        await server.stop();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
}

test("processing registration releases throwing handlers and the non-HTTP path needs no reservation", async (): Promise<void> => {
  for (const bounded of [true, false]) {
    let active: number = 0;
    let reservations: number = 0;
    const application: MurmurApplication = new MurmurApplication({
      branchName: null,
      client: null,
      repositoryName: null,
      reserveProcessingCapacity: bounded
        ? (): (() => void) | null => {
            if (active !== 0) return null;
            active += 1;
            reservations += 1;
            return (): void => {
              active -= 1;
            };
          }
        : undefined,
      store: null,
    });
    const client: Client = new Client({ name: "processing-capacity-test", version: "1.0.0" });
    const [clientTransport, serverTransport]: [InMemoryTransport, InMemoryTransport] =
      InMemoryTransport.createLinkedPair();
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      // Built-in initialization now uses the same admission wrapper as later handlers.
      expect(reservations).toBe(bounded ? 1 : 0);
      expect(active).toBe(0);
      for (const asynchronous of [false, true]) {
        application.server.setRequestHandler(
          ListToolsRequestSchema,
          (): ListToolsResult | Promise<ListToolsResult> => {
            const failure: McpError = new McpError(-32602, "Fixed injected failure");
            if (asynchronous) return Promise.reject(failure);
            throw failure;
          },
        );
        await expect(client.listTools()).rejects.toThrow("Fixed injected failure");
        expect(active).toBe(0);
      }
      application.server.setRequestHandler(
        ListToolsRequestSchema,
        (): ListToolsResult => ({ tools: [] }),
      );
      expect(await client.listTools()).toEqual({ tools: [] });
      expect(active).toBe(0);
      expect(reservations).toBe(bounded ? 4 : 0);
    } finally {
      await client.close();
      await application.close();
    }
  }
});
