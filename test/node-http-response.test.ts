import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { TimeSource } from "../src/http/http-capacity.js";
import {
  NODE_RESPONSE_CHUNK_BYTES,
  type NodeResponseWriter,
  pumpNodeResponse,
} from "../src/http/node-http-response.js";

type Gate = { readonly promise: Promise<void>; readonly resolve: () => void };

class TestWriter extends EventEmitter implements NodeResponseWriter {
  public destroyed: boolean = false;
  public statusCode: number = 0;
  public statusMessage: string = "";
  public readonly headers: Map<string, string | readonly string[]> = new Map();
  public readonly writes: Uint8Array[] = [];
  public written: Gate = Promise.withResolvers<void>();
  public accepts: boolean = false;
  public headerFailure: boolean = false;

  public setHeader(name: string, value: string | readonly string[]): void {
    if (this.headerFailure) throw new Error("Fixture header failure");
    this.headers.set(name, value);
  }

  public write(chunk: Uint8Array): boolean {
    this.writes.push(chunk);
    this.written.resolve();
    this.written = Promise.withResolvers<void>();
    return this.accepts;
  }
}

test("native response pump waits for each drain before more bytes or source EOF", async (): Promise<void> => {
  const writer: TestWriter = new TestWriter();
  const controller: AbortController = new AbortController();
  const payload: Uint8Array = new Uint8Array(NODE_RESPONSE_CHUNK_BYTES * 2 + 3).fill(19);
  let pulls: number = 0;
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(source: ReadableStreamDefaultController<Uint8Array>): void {
        pulls += 1;
        if (pulls === 1) source.enqueue(payload);
        else source.close();
      },
    },
    { highWaterMark: 0 },
  );
  let writeReady: Promise<void> = writer.written.promise;
  const pending: Promise<void> = pumpNodeResponse(new Response(body), writer, controller.signal);
  try {
    for (let count: number = 1; count <= 3; count += 1) {
      await writeReady;
      expect(writer.writes).toHaveLength(count);
      const chunk: Uint8Array | undefined = writer.writes.at(-1);
      if (chunk === undefined) throw new Error("Expected a written chunk");
      expect(chunk.byteLength).toBe(count === 3 ? 3 : NODE_RESPONSE_CHUNK_BYTES);
      expect(chunk.buffer).toBe(payload.buffer);
      expect(chunk.byteOffset).toBe((count - 1) * NODE_RESPONSE_CHUNK_BYTES);
      expect(pulls).toBe(1);
      expect(body.locked).toBe(true);
      await Promise.resolve();
      expect(writer.writes).toHaveLength(count);
      writeReady = writer.written.promise;
      writer.emit("drain");
    }
    await pending;
    expect(pulls).toBe(2);
    expect(body.locked).toBe(false);
    expect(writer.eventNames()).toEqual([]);
  } finally {
    controller.abort();
    await pending.catch((): void => {});
  }
});

test("pump preserves response metadata, separate cookies and bodyless output", async (): Promise<void> => {
  const writer: TestWriter = new TestWriter();
  const headers: Headers = new Headers({ "x-fixture": "preserved" });
  headers.append("set-cookie", "first=1; HttpOnly");
  headers.append("set-cookie", "second=2; Secure");
  await pumpNodeResponse(
    new Response(null, { status: 204, statusText: "No Content", headers }),
    writer,
    new AbortController().signal,
  );
  expect(writer.statusCode).toBe(204);
  expect(writer.statusMessage).toBe("No Content");
  expect(writer.headers.get("x-fixture")).toBe("preserved");
  expect(writer.headers.get("set-cookie")).toEqual(["first=1; HttpOnly", "second=2; Secure"]);
  expect(writer.writes).toEqual([]);
});

for (const termination of ["abort", "close", "error"]) {
  test(`pump releases a drain wait and source on ${termination}`, async (): Promise<void> => {
    const writer: TestWriter = new TestWriter();
    const controller: AbortController = new AbortController();
    const reasons: unknown[] = [];
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
      {
        pull(source: ReadableStreamDefaultController<Uint8Array>): void {
          source.enqueue(new Uint8Array(NODE_RESPONSE_CHUNK_BYTES * 2));
        },
        cancel(reason: unknown): void {
          reasons.push(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const writeReady: Promise<void> = writer.written.promise;
    const pending: Promise<void> = pumpNodeResponse(new Response(body), writer, controller.signal);
    void pending.catch((): void => {});
    await writeReady;
    if (termination === "abort") controller.abort();
    else writer.emit(termination, new Error("sensitive fixture details"));
    await expect(pending).rejects.toThrow(
      termination === "error" ? "HTTP response write failed" : "HTTP response connection closed",
    );
    expect(writer.writes).toHaveLength(1);
    expect(reasons).toEqual(["HTTP response closed"]);
    expect(body.locked).toBe(false);
    expect(writer.eventNames()).toEqual([]);
  });
}

test("pre-aborted requests and failed header writes cancel an untouched response", async (): Promise<void> => {
  for (const failure of ["abort", "headers"]) {
    const writer: TestWriter = new TestWriter();
    const controller: AbortController = new AbortController();
    let cancelled: number = 0;
    let pulls: number = 0;
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
      {
        pull(): void {
          pulls += 1;
        },
        cancel(): void {
          cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
    if (failure === "abort") controller.abort();
    else writer.headerFailure = true;
    await expect(
      pumpNodeResponse(
        new Response(body, { headers: { "x-fixture": "present" } }),
        writer,
        controller.signal,
      ),
    ).rejects.toThrow(
      failure === "abort" ? "HTTP response connection closed" : "Fixture header failure",
    );
    expect(cancelled).toBe(1);
    expect(pulls).toBe(0);
    expect(writer.writes).toEqual([]);
    expect(body.locked).toBe(false);
  }
});

test("aborting a pending source read cancels and releases its lock", async (): Promise<void> => {
  const writer: TestWriter = new TestWriter();
  const controller: AbortController = new AbortController();
  const entered: Gate = Promise.withResolvers<void>();
  const released: Gate = Promise.withResolvers<void>();
  let cancelled: number = 0;
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      async pull(): Promise<void> {
        entered.resolve();
        await released.promise;
      },
      cancel(): void {
        cancelled += 1;
      },
    },
    { highWaterMark: 0 },
  );
  const pending: Promise<void> = pumpNodeResponse(new Response(body), writer, controller.signal);
  void pending.catch((): void => {});
  try {
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("HTTP response connection closed");
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
    expect(writer.writes).toEqual([]);
  } finally {
    released.resolve();
    controller.abort();
  }
});

test("accepted writes preserve empty and multiple chunks without unnecessary drain waits", async (): Promise<void> => {
  const writer: TestWriter = new TestWriter();
  writer.accepts = true;
  const chunks: Uint8Array[] = [new Uint8Array(0), new Uint8Array([1, 2]), new Uint8Array([3])];
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(source: ReadableStreamDefaultController<Uint8Array>): void {
        const chunk: Uint8Array | undefined = chunks.shift();
        if (chunk === undefined) source.close();
        else source.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  await pumpNodeResponse(new Response(body), writer, new AbortController().signal);
  expect(writer.writes.map((bytes: Uint8Array): number[] => Array.from(bytes))).toEqual([
    [1, 2],
    [3],
  ]);
  expect(body.locked).toBe(false);
  expect(writer.eventNames()).toEqual([]);
});

test("response cleanup is deadline-bounded even when its source cancellation never settles", async (): Promise<void> => {
  const writer: TestWriter = new TestWriter();
  const controller: AbortController = new AbortController();
  const release: Gate = Promise.withResolvers<void>();
  const cleanupStarted: Gate = Promise.withResolvers<void>();
  const clockState: { deadline: (() => void) | null } = { deadline: null };
  const time: TimeSource = {
    now: (): number => 0,
    schedule(milliseconds: number, wake: () => void): () => void {
      expect(milliseconds).toBe(2_000);
      clockState.deadline = wake;
      cleanupStarted.resolve();
      return (): void => {
        clockState.deadline = null;
      };
    },
  };
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(source: ReadableStreamDefaultController<Uint8Array>): void {
        source.enqueue(new Uint8Array([1]));
      },
      async cancel(): Promise<void> {
        await release.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const writeReady: Promise<void> = writer.written.promise;
  const pending: Promise<void> = pumpNodeResponse(
    new Response(body),
    writer,
    controller.signal,
    time,
  );
  void pending.catch((): void => {});
  try {
    await writeReady;
    controller.abort();
    await cleanupStarted.promise;
    if (clockState.deadline === null) throw new Error("Expected a response cleanup deadline");
    clockState.deadline();
    await expect(pending).rejects.toThrow("HTTP response cleanup deadline exceeded");
    expect(body.locked).toBe(false);
    expect(writer.eventNames()).toEqual([]);
  } finally {
    release.resolve();
    controller.abort();
  }
});

test("source cleanup rejection is translated to a fixed error and unlocks the reader", async (): Promise<void> => {
  const writer: TestWriter = new TestWriter();
  const controller: AbortController = new AbortController();
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(source: ReadableStreamDefaultController<Uint8Array>): void {
        source.enqueue(new Uint8Array([1]));
      },
      cancel(): Promise<void> {
        return Promise.reject(new Error("sensitive source details"));
      },
    },
    { highWaterMark: 0 },
  );
  const written: Promise<void> = writer.written.promise;
  const pending: Promise<void> = pumpNodeResponse(new Response(body), writer, controller.signal);
  void pending.catch((): void => {});
  await written;
  controller.abort();
  await expect(pending).rejects.toThrow("HTTP response cleanup failed");
  expect(body.locked).toBe(false);
  expect(writer.eventNames()).toEqual([]);
});
