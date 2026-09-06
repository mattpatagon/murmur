import type { TimeSource } from "./http-capacity.js";

export type ResponseFinishReason = "bodyless" | "cancelled" | "completed" | "failed";
const MAX_RESPONSE_CHUNK_BYTES: number = 32 * 1024;

export function responseWithFinish(
  response: Response,
  onFinish: (reason: ResponseFinishReason) => void,
): Response {
  if (response.body === null) {
    onFinish("bodyless");
    return response;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let finished: boolean = false;
  let cancelling: boolean = false;
  let pending: Uint8Array | null = null;
  let offset: number = 0;
  const finish: (reason: ResponseFinishReason) => void = (reason: ResponseFinishReason): void => {
    if (finished) return;
    finished = true;
    pending = null;
    reader.releaseLock();
    onFinish(reason);
  };
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      cancel: async (reason: unknown): Promise<void> => {
        cancelling = true;
        pending = null;
        try {
          return reader.cancel(reason);
        } finally {
          // Cancellation closes pending reads immediately, independently of source cleanup.
          finish("cancelled");
        }
      },
      pull: async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
        if (cancelling || finished) return;
        try {
          if (pending === null) {
            const result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
              await reader.read();
            if (cancelling || finished) return;
            if (result.done) {
              finish("completed");
              controller.close();
              return;
            }
            if (!(result.value instanceof Uint8Array)) {
              const cancellation: Promise<void> = reader.cancel("Invalid response body chunk");
              finish("failed");
              controller.error(new Error("Response body yielded non-byte data"));
              await cancellation;
              return;
            }
            pending = result.value;
            offset = 0;
          }
          const end: number = Math.min(pending.byteLength, offset + MAX_RESPONSE_CHUNK_BYTES);
          controller.enqueue(pending.subarray(offset, end));
          offset = end;
          if (offset === pending.byteLength) pending = null;
        } catch (error: unknown) {
          if (cancelling) return;
          finish("failed");
          controller.error(error);
        }
      },
      // EOF must require fresh downstream demand, not prefetch after the final queued slice.
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function responseWithDeadline(
  response: Response,
  milliseconds: number,
  time: TimeSource,
  onDeadline: () => void,
): Response {
  if (response.body === null) return response;
  const cancelDeadline: () => void = time.schedule(milliseconds, onDeadline);
  return responseWithFinish(response, cancelDeadline);
}

export function trackedResponse(
  response: Response,
  counter: { activeResponses: number },
): Response {
  if (response.body === null) return response;
  counter.activeResponses += 1;
  return responseWithFinish(response, (): void => {
    counter.activeResponses -= 1;
  });
}
