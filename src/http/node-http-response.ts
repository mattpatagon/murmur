export const NODE_RESPONSE_CHUNK_BYTES: number = 32 * 1024;
const RESPONSE_CLEANUP_MS: number = 2_000;

type ResponseListener = (...arguments_: unknown[]) => void;

export type NodeResponseWriter = {
  readonly destroyed: boolean;
  statusCode: number;
  statusMessage: string;
  setHeader(name: string, value: string | readonly string[]): unknown;
  write(chunk: Uint8Array): boolean;
  once(event: string, listener: ResponseListener): unknown;
  off(event: string, listener: ResponseListener): unknown;
};

function closedResponse(): Error {
  return new Error("HTTP response connection closed");
}

function checkOpen(writer: NodeResponseWriter, signal: AbortSignal): void {
  if (signal.aborted || writer.destroyed) throw closedResponse();
}

function waitForDrain(writer: NodeResponseWriter, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    let settled: boolean = false;
    const settle: (error: Error | null) => void = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      writer.off("drain", drained);
      writer.off("close", closed);
      writer.off("error", failed);
      signal.removeEventListener("abort", closed);
      if (error === null) resolve();
      else reject(error);
    };
    const drained: () => void = (): void => settle(null);
    const closed: () => void = (): void => settle(closedResponse());
    const failed: ResponseListener = (): void => settle(new Error("HTTP response write failed"));
    writer.once("drain", drained);
    writer.once("close", closed);
    writer.once("error", failed);
    signal.addEventListener("abort", closed, { once: true });
    if (signal.aborted || writer.destroyed) closed();
  });
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  time: TimeSource,
): Promise<void> {
  const pending: Promise<void> = reader.cancel("HTTP response closed");
  reader.releaseLock();
  return new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    const cancelDeadline: () => void = time.schedule(RESPONSE_CLEANUP_MS, (): void => {
      reject(new Error("HTTP response cleanup deadline exceeded"));
    });
    void pending.then(
      (): void => {
        cancelDeadline();
        resolve();
      },
      (): void => {
        cancelDeadline();
        reject(new Error("HTTP response cleanup failed"));
      },
    );
  });
}

/** The caller owns end/connection teardown; finish/end are not remote acknowledgements. */
export async function pumpNodeResponse(
  response: Response,
  writer: NodeResponseWriter,
  signal: AbortSignal,
  time: TimeSource = SYSTEM_TIME_SOURCE,
): Promise<void> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | null =
    response.body === null ? null : response.body.getReader();
  let completed: boolean = false;
  let cleanup: Promise<void> | null = null;
  const cancel: () => void = (): void => {
    if (reader === null || completed || cleanup !== null) return;
    // Observe rejection immediately; final cleanup still reports its safe failure to the caller.
    cleanup = cancelReader(reader, time);
    void cleanup.catch((): void => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    checkOpen(writer, signal);
    writer.statusCode = response.status;
    writer.statusMessage = response.statusText;
    response.headers.forEach((value: string, name: string): void => {
      if (name !== "set-cookie") writer.setHeader(name, value);
    });
    const cookies: string[] = response.headers.getSetCookie();
    if (cookies.length > 0) writer.setHeader("set-cookie", cookies);
    if (reader === null) return;
    while (true) {
      checkOpen(writer, signal);
      const part: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
        await reader.read();
      checkOpen(writer, signal);
      if (part.done) {
        completed = true;
        return;
      }
      if (!(part.value instanceof Uint8Array)) {
        throw new Error("HTTP response expected byte data");
      }
      for (
        let offset: number = 0;
        offset < part.value.byteLength;
        offset += NODE_RESPONSE_CHUNK_BYTES
      ) {
        checkOpen(writer, signal);
        const chunk: Uint8Array = part.value.subarray(
          offset,
          Math.min(part.value.byteLength, offset + NODE_RESPONSE_CHUNK_BYTES),
        );
        // Bun's node:http false-write/drain contract covers its native response buffer.
        // Demand for the next chunk, including EOF, must wait for that drain.
        if (!writer.write(chunk)) await waitForDrain(writer, signal);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (completed && reader !== null) reader.releaseLock();
    else {
      cancel();
      if (cleanup !== null) await cleanup;
    }
  }
}

import { SYSTEM_TIME_SOURCE, type TimeSource } from "./http-capacity.js";
