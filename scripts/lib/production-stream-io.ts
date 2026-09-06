import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  type ProductionStreamClock,
  ProductionStreamFailure,
  requireProductionStream,
} from "./production-stream-contracts.js";

export const PRODUCTION_STREAM_CLOCK: ProductionStreamClock = {
  now: (): number => performance.now(),
  timestamp: (): string => new Date().toISOString(),
  sleep: async (milliseconds: number, signal: AbortSignal): Promise<void> => {
    requireProductionStream(Number.isFinite(milliseconds) && milliseconds >= 0);
    await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      const finish: () => void = (): void => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout(finish, milliseconds);
      const abort: () => void = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new ProductionStreamFailure());
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  },
};

export async function streamDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number = 20_000,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller: AbortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = (): void => {};
  const deadline: Promise<never> = new Promise<never>(
    (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
      cancel = (): void => {
        controller.abort();
        reject(new ProductionStreamFailure());
      };
      timer = setTimeout(cancel, milliseconds);
      if (outerSignal !== undefined) outerSignal.addEventListener("abort", cancel, { once: true });
    },
  );
  try {
    if (outerSignal !== undefined && outerSignal.aborted) cancel();
    return await Promise.race([
      Promise.resolve().then(async (): Promise<T> => {
        controller.signal.throwIfAborted();
        return await operation(controller.signal);
      }),
      deadline,
    ]);
  } catch (_error: unknown) {
    controller.abort();
    throw new ProductionStreamFailure();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (outerSignal !== undefined) outerSignal.removeEventListener("abort", cancel);
  }
}

export async function streamJsonResponse(
  response: Response,
  outerSignal?: AbortSignal,
): Promise<unknown> {
  requireProductionStream(response.body !== null);
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes: number = 0;
  const deadline: number = performance.now() + 20_000;
  try {
    const mediaType: string | undefined = (response.headers.get("content-type") ?? "").split(
      ";",
    )[0];
    requireProductionStream(
      mediaType !== undefined && mediaType.trim().toLowerCase() === "application/json",
    );
    while (true) {
      requireProductionStream(performance.now() < deadline);
      const part: Awaited<ReturnType<typeof reader.read>> = await streamDeadline(
        async (): Promise<Awaited<ReturnType<typeof reader.read>>> => await reader.read(),
        Math.max(1, deadline - performance.now()),
        outerSignal,
      );
      if (part.done) break;
      bytes += part.value.byteLength;
      requireProductionStream(bytes <= 1_048_576 && chunks.length < 16_384);
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error: unknown) {
    throw new ProductionStreamFailure();
  } finally {
    try {
      await streamDeadline(async (): Promise<void> => await reader.cancel(), 2_000);
    } finally {
      reader.releaseLock();
    }
  }
}

export async function streamJsonRequest(
  fetch_: FetchLike,
  url: URL,
  init: RequestInit = {},
  outerSignal?: AbortSignal,
): Promise<{ readonly status: number; readonly value: unknown }> {
  return await streamDeadline(
    async (
      signal: AbortSignal,
    ): Promise<{
      readonly status: number;
      readonly value: unknown;
    }> => {
      const response: Response = await fetch_(url, { ...init, redirect: "error", signal });
      return { status: response.status, value: await streamJsonResponse(response, signal) };
    },
    20_000,
    outerSignal,
  );
}
