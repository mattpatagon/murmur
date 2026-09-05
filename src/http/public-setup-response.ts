import type { TimeSource } from "./http-capacity.js";

export function publicSetupResponse(
  response: Response,
  release: () => void,
  time: TimeSource,
): Response {
  if (response.body === null) {
    release();
    return response;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let finished: boolean = false;
  const timer: { cancel: () => void } = { cancel: (): void => undefined };
  const finish: () => void = (): void => {
    if (finished) return;
    finished = true;
    timer.cancel();
    release();
  };
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      timer.cancel = time.schedule(30_000, (): void => {
        controller.error(new Error("Public setup response deadline exceeded"));
        void reader.cancel().catch((_error: unknown): void => undefined);
        finish();
      });
    },
    async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      try {
        const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
        if (finished) return;
        if (chunk.done) {
          controller.close();
          finish();
        } else controller.enqueue(chunk.value);
      } catch (_error: unknown) {
        if (!finished) controller.error(new Error("Public setup response failed"));
        finish();
      }
    },
    cancel(): void {
      void reader.cancel().catch((_error: unknown): void => undefined);
      finish();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}
