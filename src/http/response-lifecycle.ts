import type { TimeSource } from "./http-capacity.js";

export type ResponseFinishReason = "bodyless" | "cancelled" | "completed" | "failed";

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
  const finish: (reason: ResponseFinishReason) => void = (reason: ResponseFinishReason): void => {
    if (finished) return;
    finished = true;
    onFinish(reason);
  };
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    cancel: async (reason: unknown): Promise<void> => {
      try {
        await reader.cancel(reason);
      } finally {
        finish("cancelled");
      }
    },
    pull: async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      try {
        const result: { readonly done: boolean; readonly value?: Uint8Array | undefined } =
          await reader.read();
        if (result.done) {
          finish("completed");
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error: unknown) {
        finish("failed");
        controller.error(error);
      }
    },
  });
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
