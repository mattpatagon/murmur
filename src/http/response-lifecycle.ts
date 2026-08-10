export function responseWithFinish(response: Response, onFinish: () => void): Response {
  if (response.body === null) {
    onFinish();
    return response;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let finished: boolean = false;
  const finish: () => void = (): void => {
    if (finished) return;
    finished = true;
    onFinish();
  };
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    cancel: async (reason: unknown): Promise<void> => {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
    pull: async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      try {
        const result: { readonly done: boolean; readonly value?: Uint8Array | undefined } =
          await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error: unknown) {
        finish();
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
