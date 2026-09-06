import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProductionStreamClock } from "../scripts/lib/production-stream-contracts.js";
import { streamDeadline, streamJsonResponse } from "../scripts/lib/production-stream-io.js";
import {
  ProductionStreamFetch,
  ProductionStreamRecorder,
} from "../scripts/lib/production-stream-transport.js";

const URL_: URL = new URL("https://observer.invalid/mcp");
const SESSION: string = "private-original-session";
const CLOCK: ProductionStreamClock = {
  now: (): number => 100,
  timestamp: (): string => "2026-09-05T00:00:00.000Z",
  sleep: async (): Promise<void> => {},
};
const GET: RequestInit = { method: "GET", headers: { "mcp-session-id": SESSION } };

function initialized(): ProductionStreamRecorder {
  const recorder: ProductionStreamRecorder = new ProductionStreamRecorder(CLOCK);
  const input: RequestInit = { method: "POST", body: JSON.stringify({ method: "initialize" }) };
  recorder.response(
    input,
    recorder.request(input),
    new Response("{}", {
      headers: { "mcp-session-id": SESSION },
    }),
  );
  return recorder;
}

function sse(
  status: number = 200,
  requestId: string = "10000000-0000-4000-8000-000000000001",
): Response {
  return new Response(": connected\n\n", {
    status,
    headers: { "content-type": "text/event-stream", "x-request-id": requestId },
  });
}

test("only successful SSE response headers on the original session count as reconnects", (): void => {
  const recorder: ProductionStreamRecorder = initialized();
  recorder.request(GET);
  expect(recorder.snapshot().successfulGets).toBe(0);
  recorder.response(GET, false, sse(503));
  expect(recorder.snapshot().successfulGets).toBe(0);
  recorder.response(GET, false, sse());
  recorder.response(GET, false, sse(200, "10000000-0000-4000-8000-000000000002"));
  expect(recorder.snapshot().successfulGets).toBe(2);
  expect(recorder.snapshot().successfulInitializations).toBe(1);
  expect(recorder.snapshot().sessionHash).toBe(
    createHash("sha256").update(SESSION).digest("base64url").slice(0, 22),
  );
  expect(JSON.stringify(recorder.snapshot())).not.toContain(SESSION);
});

test("changed or missing session, second initialize and wrong response media fail closed", (): void => {
  const recorder: ProductionStreamRecorder = initialized();
  expect((): void => {
    recorder.request({ method: "GET", headers: { "mcp-session-id": "other" } });
  }).toThrow();
  expect((): void => {
    recorder.request({ method: "GET" });
  }).toThrow();
  expect((): void => {
    recorder.request({ method: "POST", body: '{"method":"initialize"}' });
  }).toThrow();
  expect((): void => {
    recorder.response(GET, false, new Response("html"));
  }).toThrow();
  expect((): void => {
    recorder.response(
      GET,
      false,
      new Response("x", {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "private malformed ID",
        },
      }),
    );
  }).toThrow();
  expect(recorder.snapshot().successfulGets).toBe(0);
});

test("per-client fetch never sends a credential to another endpoint and normalizes external errors", async (): Promise<void> => {
  let calls: number = 0;
  const fetch_: FetchLike = async (): Promise<Response> => {
    calls += 1;
    throw new Error("private upstream body");
  };
  const bounded: ProductionStreamFetch = new ProductionStreamFetch(URL_, fetch_);
  await expect(bounded.fetch("https://other.invalid/mcp", {})).rejects.toThrow(
    "Production stream verification failed",
  );
  expect(calls).toBe(0);
  await expect(bounded.fetch(URL_, {})).rejects.toThrow("Production stream verification failed");
  await bounded.close();
  expect(calls).toBe(1);
});

test("stream byte limit aborts and cancels its response before SDK parsing can grow without bound", async (): Promise<void> => {
  let canceled: boolean = false;
  const raw: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      controller.enqueue(new Uint8Array(1_048_577));
    },
    cancel: (): void => {
      canceled = true;
    },
  });
  const bounded: ProductionStreamFetch = new ProductionStreamFetch(
    URL_,
    async (): Promise<Response> => new Response(raw),
  );
  const response: Response = await bounded.fetch(URL_, { method: "POST" });
  await expect(response.text()).rejects.toThrow("Production stream verification failed");
  await bounded.close();
  expect(canceled).toBe(true);
});

test("closing a client aborts an in-flight header request and awaits observed settlement", async (): Promise<void> => {
  let begun: () => void = (): void => {};
  const started: Promise<void> = new Promise<void>((resolve: () => void): void => {
    begun = resolve;
  });
  let aborted: boolean = false;
  const fetch_: FetchLike = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    if (init === undefined || init.signal === undefined || init.signal === null)
      throw new Error("missing signal");
    const signal: AbortSignal = init.signal;
    return await new Promise<Response>(
      (_resolve: (value: Response) => void, reject: (error: Error) => void): void => {
        signal.addEventListener(
          "abort",
          (): void => {
            aborted = true;
            reject(new Error("private aborted request"));
          },
          { once: true },
        );
        begun();
      },
    );
  };
  const bounded: ProductionStreamFetch = new ProductionStreamFetch(URL_, fetch_);
  const request: Promise<Response> = bounded.fetch(URL_, { method: "POST" });
  const rejected: Promise<boolean> = request.then(
    (): boolean => false,
    (error: unknown): boolean =>
      error instanceof Error && error.message === "Production stream verification failed",
  );
  await started;
  await bounded.close();
  expect(await rejected).toBe(true);
  expect(aborted).toBe(true);
});

test("an already-aborted outer scope starts no operation and returns only a fixed failure", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  controller.abort();
  let calls: number = 0;
  await expect(
    streamDeadline(
      async (): Promise<void> => {
        calls += 1;
      },
      1_000,
      controller.signal,
    ),
  ).rejects.toThrow("Production stream verification failed");
  expect(calls).toBe(0);
});

test("bounded JSON reading rejects oversized content and releases its reader", async (): Promise<void> => {
  const response: Response = new Response(`"${"a".repeat(1_048_576)}"`, {
    headers: { "content-type": "application/json" },
  });
  await expect(streamJsonResponse(response)).rejects.toThrow();
  expect(response.body === null || !response.body.locked).toBe(true);
});

test("JSON readers reject HTML before parsing and still cancel and release the body", async (): Promise<void> => {
  let canceled: boolean = false;
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    cancel: (): void => {
      canceled = true;
    },
  });
  const response: Response = new Response(body, { headers: { "content-type": "text/html" } });
  await expect(streamJsonResponse(response)).rejects.toThrow(
    "Production stream verification failed",
  );
  expect(canceled).toBe(true);
  expect(body.locked).toBe(false);
});

test("aborting a JSON body scope cancels a pending reader rather than leaving it alive", async (): Promise<void> => {
  let canceled: boolean = false;
  const controller: AbortController = new AbortController();
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull: (): void => {
      controller.abort();
    },
    cancel: (): void => {
      canceled = true;
    },
  });
  const response: Response = new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  await expect(streamJsonResponse(response, controller.signal)).rejects.toThrow(
    "Production stream verification failed",
  );
  expect(canceled).toBe(true);
  expect(body.locked).toBe(false);
});
