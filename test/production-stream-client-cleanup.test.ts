import { expect, test } from "bun:test";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { ProductionStreamClient } from "../scripts/lib/production-stream-client.js";
import type { ProductionStreamRuntime } from "../scripts/lib/production-stream-contracts.js";
import { streamDeadline } from "../scripts/lib/production-stream-io.js";

const ENDPOINT: URL = new URL("https://observer.invalid/mcp");
const SESSION: string = "10000000-0000-4000-8000-000000000001";
const FAILURE: string = "Production stream verification failed";

type CleanupOptions = {
  readonly statuses: readonly number[];
  readonly cancellationFails?: boolean;
  readonly onSleep?: (signal: AbortSignal) => void;
};

type CleanupHarness = {
  readonly client: ProductionStreamClient;
  readonly deletes: Request[];
  readonly sleeps: number[];
  readonly events: string[];
};

async function withClient(
  options: CleanupOptions,
  operation: (harness: CleanupHarness) => Promise<void>,
): Promise<void> {
  const server: Server = new Server({ name: "cleanup-test", version: "1.0.0" });
  const transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => SESSION,
      enableJsonResponse: true,
    });
  const deletes: Request[] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  const runtime: ProductionStreamRuntime = {
    clock: {
      now: (): number => 0,
      timestamp: (): string => "2026-09-06T00:00:00.000Z",
      sleep: async (milliseconds: number, signal: AbortSignal): Promise<void> => {
        sleeps.push(milliseconds);
        events.push("sleep");
        if (options.onSleep !== undefined) options.onSleep(signal);
        signal.throwIfAborted();
      },
    },
    fetch: async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const request: Request = new Request(url, init);
      if (request.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
            cancel: (): void => {
              events.push("stream-canceled");
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method !== "DELETE") return await transport.handleRequest(request);
      const status: number | undefined = options.statuses[deletes.length];
      if (status === undefined) throw new Error("Unexpected cleanup request");
      deletes.push(request);
      events.push(`delete-${status}`);
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel: (): void => {
            events.push(`body-canceled-${status}`);
            if (options.cancellationFails === true) throw new Error("private cancellation detail");
          },
        }),
        { status },
      );
    },
  };
  const client: ProductionStreamClient = new ProductionStreamClient(
    ENDPOINT,
    "private-test-credential",
    runtime,
  );
  try {
    await server.connect(transport);
    await streamDeadline(async (signal: AbortSignal): Promise<void> => {
      await client.connect(signal);
      await client.client.ping({ signal, timeout: 2_000 });
    }, 2_000);
    await operation({ client, deletes, sleeps, events });
  } finally {
    // Expected close failures must not prevent teardown of the owned SDK server.
    await Promise.allSettled([client.close()]);
    await server.close();
  }
}

test("cleanup retries transient admission failure on the same session and observes every cancellation", async (): Promise<void> => {
  await withClient({ statuses: [503, 401] }, async (harness: CleanupHarness): Promise<void> => {
    const closing: Promise<void> = harness.client.close();
    expect(harness.client.close()).toBe(closing);
    await closing;
    expect(harness.deletes).toHaveLength(2);
    expect(harness.sleeps).toEqual([1_000]);
    expect(harness.events).toEqual([
      "stream-canceled",
      "delete-503",
      "body-canceled-503",
      "sleep",
      "delete-401",
      "body-canceled-401",
    ]);
    for (const request of harness.deletes) {
      expect(request.url).toBe(ENDPOINT.href);
      expect(request.headers.get("mcp-session-id")).toBe(SESSION);
      expect(request.headers.get("mcp-protocol-version")).toBe(LATEST_PROTOCOL_VERSION);
      expect(request.headers.get("authorization")).toBe("Bearer private-test-credential");
      expect(request.redirect).toBe("error");
    }
    await harness.client.close();
    expect(harness.deletes).toHaveLength(2);
  });
});

test("cleanup exhausts exactly three unavailable responses and never accepts 503 as deletion", async (): Promise<void> => {
  await withClient(
    { statuses: [503, 503, 503, 401] },
    async (harness: CleanupHarness): Promise<void> => {
      await expect(harness.client.close()).rejects.toThrow(FAILURE);
      expect(harness.deletes).toHaveLength(3);
      expect(harness.sleeps).toEqual([1_000, 1_000]);
      expect(harness.events).toEqual([
        "stream-canceled",
        "delete-503",
        "body-canceled-503",
        "sleep",
        "delete-503",
        "body-canceled-503",
        "sleep",
        "delete-503",
        "body-canceled-503",
      ]);
      await expect(harness.client.close()).rejects.toThrow(FAILURE);
      expect(harness.deletes).toHaveLength(3);
    },
  );
});

test.each([403, 429, 500])(
  "cleanup does not retry nonretryable HTTP %i",
  async (status: number): Promise<void> => {
    await withClient(
      { statuses: [status, 401] },
      async (harness: CleanupHarness): Promise<void> => {
        await expect(harness.client.close()).rejects.toThrow(FAILURE);
        expect(harness.deletes).toHaveLength(1);
        expect(harness.sleeps).toEqual([]);
        expect(harness.events).toEqual([
          "stream-canceled",
          `delete-${status}`,
          `body-canceled-${status}`,
        ]);
      },
    );
  },
);

test("cleanup cannot retry or succeed when response cancellation fails", async (): Promise<void> => {
  await withClient(
    { statuses: [503, 401], cancellationFails: true },
    async (harness: CleanupHarness): Promise<void> => {
      await expect(harness.client.close()).rejects.toThrow(FAILURE);
      expect(harness.deletes).toHaveLength(1);
      expect(harness.sleeps).toEqual([]);
      expect(harness.events).toEqual(["stream-canceled", "delete-503", "body-canceled-503"]);
    },
  );
});

test("caller abort during retry delay prevents another DELETE after local streams are closed", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  let sleepAborted: boolean = false;
  await withClient(
    {
      statuses: [503, 401],
      onSleep: (signal: AbortSignal): void => {
        controller.abort();
        sleepAborted = signal.aborted;
      },
    },
    async (harness: CleanupHarness): Promise<void> => {
      await expect(harness.client.close(controller.signal)).rejects.toThrow(FAILURE);
      expect(sleepAborted).toBe(true);
      expect(harness.deletes).toHaveLength(1);
      expect(harness.sleeps).toEqual([1_000]);
      expect(harness.events).toEqual([
        "stream-canceled",
        "delete-503",
        "body-canceled-503",
        "sleep",
      ]);
    },
  );
});
