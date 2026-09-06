import { expect, test } from "bun:test";

import type { TimeSource } from "../src/http/http-capacity.js";
import { parseRequestBody, requestBodyBytes } from "../src/http/http-request.js";

class BodyTime implements TimeSource {
  public current: number = 0;
  public wake: (() => void) | null = null;
  public cancellations: number = 0;

  public now(): number {
    return this.current;
  }

  public schedule(milliseconds: number, wake: () => void): () => void {
    expect(milliseconds).toBe(10_000);
    this.wake = wake;
    return (): void => {
      this.wake = null;
      this.cancellations += 1;
    };
  }

  public expire(): void {
    this.current += 10_000;
    if (this.wake !== null) this.wake();
  }
}

test("a partial body has one absolute deadline and cancels an unfinished reader", async (): Promise<void> => {
  const time: BodyTime = new BodyTime();
  let canceled: boolean = false;
  const stream: TransformStream<Uint8Array, Uint8Array> = new TransformStream<
    Uint8Array,
    Uint8Array
  >();
  const writer: WritableStreamDefaultWriter<Uint8Array> = stream.writable.getWriter();
  const request: Request = new Request("http://localhost/mcp", {
    body: stream.readable,
    method: "POST",
  });
  const reading: Promise<unknown> = requestBodyBytes(request, 1_024, time).catch(
    (error: unknown): unknown => error,
  );
  try {
    await writer.write(new TextEncoder().encode("{"));
    expect(time.wake).not.toBeNull();
    const closing: Promise<void> = writer.closed.catch((_error: unknown): void => {
      canceled = true;
    });
    time.expire();
    const result: unknown = await reading;
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) throw new Error("Expected request body timeout");
    expect(result.name).toBe("RequestBodyTimeoutError");
    expect(result.message).toBe("Request body deadline exceeded");
    await closing;
    expect(canceled).toBe(true);
    expect(time.cancellations).toBe(1);
    expect(request.bodyUsed).toBe(true);
  } finally {
    await writer.abort().catch((_error: unknown): void => {});
    await reading;
    writer.releaseLock();
  }
});

test("complete bodies cancel the deadline timer", async (): Promise<void> => {
  const time: BodyTime = new BodyTime();
  const request: Request = new Request("http://localhost/mcp", { body: "{}", method: "POST" });
  expect(new TextDecoder().decode(await requestBodyBytes(request, 2, time))).toBe("{}");
  expect(time.wake).toBeNull();
  expect(time.cancellations).toBe(1);
});

test("fragmented bodies grow within the byte limit and preserve their contents", async (): Promise<void> => {
  const time: BodyTime = new BodyTime();
  const content: string = "a".repeat(40_000);
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      const bytes: Uint8Array = new TextEncoder().encode(content);
      for (let index: number = 0; index < bytes.length; index += 127) {
        controller.enqueue(bytes.subarray(index, index + 127));
      }
      controller.close();
    },
  });
  const request: Request = new Request("http://localhost/mcp", { body, method: "POST" });
  expect(new TextDecoder().decode(await requestBodyBytes(request, 40_000, time))).toBe(content);
  expect(time.cancellations).toBe(1);
});

test("a producer cannot extend a body deadline by continuing to supply chunks", async (): Promise<void> => {
  const time: BodyTime = new BodyTime();
  const request: Request = new Request("http://localhost/mcp", {
    body: new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        time.current += 10_000;
        controller.enqueue(new TextEncoder().encode(" "));
      },
    }),
    method: "POST",
  });
  await expect(parseRequestBody(request, 1_024, time)).rejects.toThrow(
    "Request body deadline exceeded",
  );
  expect(time.cancellations).toBe(1);
});

test("a final read arriving at the deadline cannot succeed before the timer runs", async (): Promise<void> => {
  const time: BodyTime = new BodyTime();
  const request: Request = new Request("http://localhost/mcp", {
    body: new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        time.current += 10_000;
        controller.close();
      },
    }),
    method: "POST",
  });
  await expect(requestBodyBytes(request, 1_024, time)).rejects.toThrow(
    "Request body deadline exceeded",
  );
  expect(time.cancellations).toBe(1);
});
