import { expect, test } from "bun:test";

import { type ResponseFinishReason, responseWithFinish } from "../src/http/response-lifecycle.js";

const CHUNK_BYTES: number = 32 * 1024;
type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
type Gate = { readonly promise: Promise<void>; readonly resolve: () => void };

function responseReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (response.body === null) throw new Error("Expected a streaming response");
  return response.body.getReader();
}

test("a multi-MiB source chunk advances only in bounded slices demanded by the consumer", async (): Promise<void> => {
  const bytes: Uint8Array = new Uint8Array(2 * 1024 * 1024 + 7).subarray(7);
  bytes.fill(37);
  const finishes: ResponseFinishReason[] = [];
  let pulls: number = 0;
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        pulls += 1;
        if (pulls === 1) controller.enqueue(bytes);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const wrapped: Response = responseWithFinish(
    new Response(source, {
      status: 202,
      statusText: "Queued",
      headers: { "x-stream-test": "preserved" },
    }),
    (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    },
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(wrapped);
  try {
    expect(wrapped.status).toBe(202);
    expect(wrapped.statusText).toBe("Queued");
    expect(wrapped.headers.get("x-stream-test")).toBe("preserved");
    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBe(0);
    expect(finishes).toEqual([]);
    for (let offset: number = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      const part: ReadResult = await reader.read();
      if (part.done) throw new Error("Response ended before its source bytes");
      expect(part.value.byteLength).toBe(CHUNK_BYTES);
      expect(part.value.buffer).toBe(bytes.buffer);
      expect(part.value.byteOffset).toBe(bytes.byteOffset + offset);
      expect(part.value[0]).toBe(37);
      await Promise.resolve();
      await Promise.resolve();
      expect(pulls).toBe(1);
      expect(finishes).toEqual([]);
    }
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(pulls).toBe(2);
    expect(finishes).toEqual(["completed"]);
    expect(source.locked).toBe(false);
    await reader.cancel();
    expect(finishes).toEqual(["completed"]);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});

test("empty and multiple source chunks preserve bytes without reading ahead", async (): Promise<void> => {
  const chunks: Uint8Array[] = [
    new Uint8Array(0),
    new Uint8Array(CHUNK_BYTES + 3).fill(9),
    new Uint8Array(0),
    new Uint8Array([4, 5]),
  ];
  const finishes: ResponseFinishReason[] = [];
  let pulls: number = 0;
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        const chunk: Uint8Array | undefined = chunks[pulls];
        pulls += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    for (const expected of [
      { length: 0, pulls: 1, byte: undefined },
      { length: CHUNK_BYTES, pulls: 2, byte: 9 },
      { length: 3, pulls: 2, byte: 9 },
      { length: 0, pulls: 3, byte: undefined },
      { length: 2, pulls: 4, byte: 4 },
    ]) {
      const part: ReadResult = await reader.read();
      if (part.done) throw new Error("Response ended before all chunks");
      expect(part.value.byteLength).toBe(expected.length);
      expect(part.value[0]).toBe(expected.byte);
      await Promise.resolve();
      await Promise.resolve();
      expect(pulls).toBe(expected.pulls);
      expect(finishes).toEqual([]);
    }
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(finishes).toEqual(["completed"]);
    expect(source.locked).toBe(false);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});

test("cancelling after a prefix discards remaining slices and unlocks the source once", async (): Promise<void> => {
  const finishes: ResponseFinishReason[] = [];
  const cancellations: unknown[] = [];
  let pulls: number = 0;
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        pulls += 1;
        controller.enqueue(new Uint8Array(CHUNK_BYTES * 3));
      },
      cancel(reason: unknown): void {
        cancellations.push(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    const part: ReadResult = await reader.read();
    if (part.done) throw new Error("Expected a response prefix");
    expect(part.value.byteLength).toBe(CHUNK_BYTES);
    await reader.cancel("fixture disconnect");
    await reader.cancel("duplicate disconnect");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(pulls).toBe(1);
    expect(cancellations).toEqual(["fixture disconnect"]);
    expect(finishes).toEqual(["cancelled"]);
    expect(source.locked).toBe(false);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});

test("cancel during a pending read finishes and unlocks before blocked source cleanup settles", async (): Promise<void> => {
  const entered: Gate = Promise.withResolvers<void>();
  const readRelease: Gate = Promise.withResolvers<void>();
  const cancelRelease: Gate = Promise.withResolvers<void>();
  const finishes: ResponseFinishReason[] = [];
  const cancellations: unknown[] = [];
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      async pull(_controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        entered.resolve();
        await readRelease.promise;
      },
      async cancel(reason: unknown): Promise<void> {
        cancellations.push(reason);
        await cancelRelease.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    const pendingRead: Promise<ReadResult> = reader.read();
    await entered.promise;
    let cancellationSettled: boolean = false;
    const cancelled: Promise<void> = reader.cancel("pending fixture").then((): void => {
      cancellationSettled = true;
    });
    expect(await pendingRead).toEqual({ done: true, value: undefined });
    expect(source.locked).toBe(false);
    expect(finishes).toEqual(["cancelled"]);
    expect(cancellations).toEqual(["pending fixture"]);
    expect(cancellationSettled).toBe(false);
    readRelease.resolve();
    await Promise.resolve();
    expect(finishes).toEqual(["cancelled"]);
    expect(cancellationSettled).toBe(false);
    cancelRelease.resolve();
    await cancelled;
    expect(cancellationSettled).toBe(true);
    await reader.cancel();
    expect(finishes).toEqual(["cancelled"]);
  } finally {
    readRelease.resolve();
    cancelRelease.resolve();
    await reader.cancel();
    reader.releaseLock();
  }
});

test("rejected source cancellation preserves its error without stranding finish or the reader lock", async (): Promise<void> => {
  const failure: Error = new Error("fixture cleanup rejection");
  const finishes: ResponseFinishReason[] = [];
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    cancel(): Promise<void> {
      return Promise.reject(failure);
    },
  });
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    await expect(reader.cancel()).rejects.toBe(failure);
    expect(finishes).toEqual(["cancelled"]);
    expect(source.locked).toBe(false);
    await reader.cancel();
    expect(finishes).toEqual(["cancelled"]);
  } finally {
    reader.releaseLock();
  }
});

test("source read failures unlock and finish exactly once", async (): Promise<void> => {
  const failure: Error = new Error("fixture read rejection");
  const finishes: ResponseFinishReason[] = [];
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.error(failure);
      },
    },
    { highWaterMark: 0 },
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    await expect(reader.read()).rejects.toBe(failure);
    expect(finishes).toEqual(["failed"]);
    expect(source.locked).toBe(false);
    await expect(reader.read()).rejects.toBe(failure);
    expect(finishes).toEqual(["failed"]);
  } finally {
    reader.releaseLock();
  }
});

test("non-byte data fails and unlocks without waiting for source cancellation cleanup", async (): Promise<void> => {
  const cleanup: Gate = Promise.withResolvers<void>();
  const finishes: ResponseFinishReason[] = [];
  let cancellations: number = 0;
  const source: ReadableStream<unknown> = new ReadableStream<unknown>(
    {
      pull(controller: ReadableStreamDefaultController<unknown>): void {
        controller.enqueue("not native response bytes");
      },
      cancel(): Promise<void> {
        cancellations += 1;
        return cleanup.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    await expect(reader.read()).rejects.toThrow("Response body yielded non-byte data");
    expect(finishes).toEqual(["failed"]);
    expect(source.locked).toBe(false);
    expect(cancellations).toBe(1);
    cleanup.resolve();
    await Promise.resolve();
    expect(finishes).toEqual(["failed"]);
  } finally {
    cleanup.resolve();
    reader.releaseLock();
  }
});

test("bodyless responses finish immediately while closed streams require an explicit EOF read", async (): Promise<void> => {
  const bodylessFinishes: ResponseFinishReason[] = [];
  const bodyless: Response = new Response(null, { status: 204, headers: { "x-fixture": "empty" } });
  expect(
    responseWithFinish(bodyless, (reason: ResponseFinishReason): void => {
      bodylessFinishes.push(reason);
    }),
  ).toBe(bodyless);
  expect(bodylessFinishes).toEqual(["bodyless"]);
  const finishes: ResponseFinishReason[] = [];
  const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.close();
    },
  });
  const reader: ReadableStreamDefaultReader<Uint8Array> = responseReader(
    responseWithFinish(new Response(source), (reason: ResponseFinishReason): void => {
      finishes.push(reason);
    }),
  );
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(finishes).toEqual([]);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(finishes).toEqual(["completed"]);
    expect(source.locked).toBe(false);
    await reader.cancel();
    expect(finishes).toEqual(["completed"]);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});
