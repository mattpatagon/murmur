import { createHash } from "node:crypto";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import {
  type ProductionStreamClock,
  ProductionStreamFailure,
  type ProductionStreamSnapshot,
  requireProductionStream,
} from "./production-stream-contracts.js";
import { streamDeadline } from "./production-stream-io.js";

const SessionSchema: z.ZodString = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+(?![\s\S])/u);
const RequestIdSchema: z.ZodString = z.string().uuid().length(36);
const MethodSchema: z.ZodType<{ readonly method?: string | undefined }> = z.object({
  method: z.string().optional(),
});

export class ProductionStreamRecorder {
  private originalSession: string | null = null;
  private state: ProductionStreamSnapshot = {
    initializationAttempts: 0,
    successfulInitializations: 0,
    successfulGets: 0,
    sessionHash: null,
    firstGetAt: null,
    firstGetTimestamp: null,
    reconnectAt: null,
    reconnectTimestamp: null,
    initialRequestId: null,
    replacementRequestId: null,
    invalid: false,
  };

  public constructor(private readonly clock: ProductionStreamClock) {}

  public snapshot(): ProductionStreamSnapshot {
    return { ...this.state };
  }

  public fail(): void {
    this.state = { ...this.state, invalid: true };
  }

  public request(init: RequestInit): boolean {
    let initialize: boolean = false;
    if (typeof init.body === "string") {
      requireProductionStream(Buffer.byteLength(init.body) <= 65_536);
      const body: unknown = JSON.parse(init.body);
      initialize = MethodSchema.parse(body).method === "initialize";
    }
    if (initialize) {
      this.state = { ...this.state, initializationAttempts: this.state.initializationAttempts + 1 };
      requireProductionStream(this.state.initializationAttempts === 1);
    }
    if (init.method === "GET") {
      requireProductionStream(
        this.originalSession !== null &&
          new Headers(init.headers).get("mcp-session-id") === this.originalSession,
      );
    }
    return initialize;
  }

  public response(init: RequestInit, initialize: boolean, response: Response): void {
    if (initialize && response.status === 200) {
      const session: string = SessionSchema.parse(response.headers.get("mcp-session-id"));
      requireProductionStream(this.originalSession === null);
      this.originalSession = session;
      this.state = {
        ...this.state,
        successfulInitializations: 1,
        sessionHash: createHash("sha256").update(session).digest("base64url").slice(0, 22),
      };
    }
    const returnedSession: string | null = response.headers.get("mcp-session-id");
    if (returnedSession !== null && this.originalSession !== null) {
      requireProductionStream(returnedSession === this.originalSession);
    }
    if (init.method !== "GET" || response.status !== 200) return;
    const mediaType: string | undefined = (response.headers.get("content-type") ?? "").split(
      ";",
    )[0];
    requireProductionStream(
      response.body !== null && mediaType !== undefined && mediaType.trim() === "text/event-stream",
    );
    const requestId: string = RequestIdSchema.parse(response.headers.get("x-request-id"));
    const count: number = this.state.successfulGets + 1;
    requireProductionStream(count <= 4);
    this.state = {
      ...this.state,
      successfulGets: count,
      firstGetAt: this.state.firstGetAt ?? this.clock.now(),
      firstGetTimestamp: this.state.firstGetTimestamp ?? this.clock.timestamp(),
      reconnectAt: count === 2 ? this.clock.now() : this.state.reconnectAt,
      reconnectTimestamp: count === 2 ? this.clock.timestamp() : this.state.reconnectTimestamp,
      initialRequestId: count === 1 ? requestId : this.state.initialRequestId,
      replacementRequestId: count === 2 ? requestId : this.state.replacementRequestId,
    };
  }
}

export class ProductionStreamFetch {
  private readonly active: Set<AbortController> = new Set<AbortController>();
  private readonly cancellations: Set<Promise<void>> = new Set<Promise<void>>();
  private readonly pending: Set<Promise<Response>> = new Set<Promise<Response>>();
  private closed: boolean = false;
  private cancellationFailed: boolean = false;

  public constructor(
    private readonly endpoint: URL,
    private readonly fetch_: FetchLike,
    private readonly recorder: ProductionStreamRecorder | null = null,
    private readonly requestTimeoutMs: number = 20_000,
  ) {}

  public readonly fetch: FetchLike = (
    url: string | URL,
    supplied?: RequestInit,
  ): Promise<Response> => {
    const request: Promise<Response> = this.request(url, supplied);
    this.pending.add(request);
    void request.then(
      (): void => {
        this.pending.delete(request);
      },
      (): void => {
        this.pending.delete(request);
      },
    );
    return request;
  };

  private async request(url: string | URL, supplied?: RequestInit): Promise<Response> {
    const init: RequestInit = supplied ?? {};
    const aborter: AbortController = new AbortController();
    requireProductionStream(
      !this.closed && this.active.size < 16 && new URL(url).href === this.endpoint.href,
    );
    this.active.add(aborter);
    const signals: AbortSignal[] = [aborter.signal];
    if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      (): void => aborter.abort(),
      init.method === "GET" ? 65 * 60_000 : this.requestTimeoutMs,
    );
    const finish: () => void = (): void => {
      clearTimeout(timer);
      this.active.delete(aborter);
    };
    let received: Response | null = null;
    try {
      const initialize: boolean = this.recorder === null ? false : this.recorder.request(init);
      const response: Response = await streamDeadline(
        async (deadline: AbortSignal): Promise<Response> =>
          await this.fetch_(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([...signals, deadline]),
          }),
        this.requestTimeoutMs,
      );
      received = response;
      requireProductionStream(!this.closed);
      if (this.recorder !== null) this.recorder.response(init, initialize, response);
      if (response.body === null) {
        finish();
        return response;
      }
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const signal: AbortSignal = AbortSignal.any(signals);
      let done: boolean = false;
      let bytes: number = 0;
      let cancel: () => void = (): void => {};
      const completed: () => void = (): void => {
        done = true;
        signal.removeEventListener("abort", cancel);
        finish();
      };
      const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
        start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
          cancel = (): void => {
            if (done) return;
            completed();
            this.cancelReader(reader);
            controller.error(new ProductionStreamFailure());
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        },
        pull: async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
          try {
            const part: Awaited<ReturnType<typeof reader.read>> = await reader.read();
            if (done) return;
            if (part.done) {
              completed();
              reader.releaseLock();
              controller.close();
              return;
            }
            bytes += part.value.byteLength;
            requireProductionStream(bytes <= 1_048_576);
            controller.enqueue(part.value);
          } catch (_error: unknown) {
            if (done) return;
            if (this.recorder !== null) this.recorder.fail();
            cancel();
          }
        },
        cancel: (): void => {
          completed();
          aborter.abort();
          this.cancelReader(reader);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (_error: unknown) {
      if (this.recorder !== null && !this.closed) this.recorder.fail();
      aborter.abort();
      finish();
      if (received !== null && received.body !== null && !received.body.locked) {
        const body: ReadableStream<Uint8Array> = received.body;
        try {
          await streamDeadline(async (): Promise<void> => await body.cancel(), 2_000);
        } catch (_cancelError: unknown) {
          this.cancellationFailed = true;
        }
      }
      throw new ProductionStreamFailure();
    }
  }

  private cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    const cancellation: Promise<void> = streamDeadline(async (): Promise<void> => {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }, 2_000).catch((_error: unknown): void => {
      this.cancellationFailed = true;
    });
    this.cancellations.add(cancellation);
    void cancellation.finally((): void => {
      this.cancellations.delete(cancellation);
    });
  }

  public abort(): void {
    this.closed = true;
    for (const controller of this.active) controller.abort();
  }

  public async close(): Promise<void> {
    this.abort();
    await streamDeadline(async (): Promise<void> => {
      await Promise.allSettled(this.pending);
      await Promise.all(this.cancellations);
    }, 3_000);
    requireProductionStream(!this.cancellationFailed && this.active.size === 0);
  }
}
