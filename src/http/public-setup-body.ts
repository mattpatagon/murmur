import { SYSTEM_TIME_SOURCE, type TimeSource } from "./http-capacity.js";

export async function readPublicSetupBody(
  request: Request,
  timeoutMs: number,
  time: TimeSource = SYSTEM_TIME_SOURCE,
): Promise<unknown> {
  const length: string | null = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 8_192)) {
    throw new Error("Invalid setup body length");
  }
  if (request.body === null) throw new Error("Missing setup body");
  if (request.signal.aborted) throw new Error("Setup request cancelled");
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  const deadlineAt: number = time.now() + timeoutMs;
  const bytes: Uint8Array = new Uint8Array(8_192);
  let total: number = 0;
  const cancellation: { cancel: () => void } = { cancel: (): void => undefined };
  const abort: { listener: () => void } = { listener: (): void => undefined };
  const deadline: Promise<never> = new Promise<never>(
    (_resolve: (value: never) => void, reject: (reason: Error) => void): void => {
      cancellation.cancel = time.schedule(timeoutMs, (): void =>
        reject(new Error("Setup body deadline exceeded")),
      );
      abort.listener = (): void => reject(new Error("Setup request cancelled"));
      request.signal.addEventListener("abort", abort.listener, { once: true });
    },
  );
  try {
    while (true) {
      if (request.signal.aborted || time.now() >= deadlineAt)
        throw new Error("Setup body interrupted");
      const chunk: Awaited<ReturnType<typeof reader.read>> = await Promise.race([
        reader.read(),
        deadline,
      ]);
      if (request.signal.aborted || time.now() >= deadlineAt)
        throw new Error("Setup body interrupted");
      if (chunk.done) break;
      if (total + chunk.value.byteLength > bytes.byteLength)
        throw new Error("Setup body exceeds its limit");
      bytes.set(chunk.value, total);
      total += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, total)));
  } finally {
    cancellation.cancel();
    request.signal.removeEventListener("abort", abort.listener);
    // Incoming bodies are untrusted: cancellation must not extend their absolute deadline.
    void reader.cancel().catch((_error: unknown): void => undefined);
    reader.releaseLock();
  }
}
