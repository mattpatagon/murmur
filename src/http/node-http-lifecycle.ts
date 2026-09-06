import { IncomingMessage, type ServerResponse } from "node:http";

const CLEANUP_TIMEOUT_MS: number = 2_000;

/** Bun 1.3.14 otherwise removes its response abort callback when input auto-destroys. */
export class ResponseLifetimeIncomingMessage extends IncomingMessage {
  private responseFinished: boolean = false;

  public override destroy(error?: Error | null): this {
    if (
      (error === undefined || error === null) &&
      this.complete &&
      this.readableEnded &&
      !this.responseFinished
    ) {
      return this;
    }
    return super.destroy(error === null ? undefined : error);
  }

  public releaseAfterResponse(): void {
    this.responseFinished = true;
    // Incomplete input destruction resets Bun's socket even after response end. The
    // response already carries Connection: close; leave that native delivery intact.
    if (this.complete && this.readableEnded) this.destroy();
  }
}

export class NodeHttpLifecycle {
  private readonly peer: AbortController = new AbortController();
  private readonly request: AbortController = new AbortController();
  private outputCompleted: boolean = false;
  private disposed: boolean = false;
  private readonly abort: () => void;

  public constructor(
    private readonly incoming: IncomingMessage,
    private readonly outgoing: ServerResponse,
  ) {
    this.abort = (): void => {
      if (this.outputCompleted) return;
      this.peer.abort();
      this.request.abort();
    };
    incoming.once("aborted", this.abort);
    incoming.once("error", this.abort);
    incoming.socket.once("close", this.abort);
    outgoing.once("close", this.abort);
    outgoing.once("error", this.abort);
  }

  public get peerSignal(): AbortSignal {
    return this.peer.signal;
  }

  public get requestSignal(): AbortSignal {
    return this.request.signal;
  }

  public abortRequest(): void {
    this.request.abort();
  }

  public close(): void {
    this.abort();
    this.outgoing.destroy();
    this.incoming.destroy();
  }

  public completeOutput(): void {
    this.outputCompleted = true;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.incoming.off("aborted", this.abort);
    this.incoming.socket.off("close", this.abort);
    this.outgoing.off("close", this.abort);
    // Keep one-shot error listeners until these request/response objects are collected.
    if (this.incoming instanceof ResponseLifetimeIncomingMessage) {
      this.incoming.releaseAfterResponse();
    }
  }
}

export async function cancelNodeResponse(response: Response): Promise<void> {
  if (response.body === null) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      response.body.cancel().catch((_error: unknown): void => undefined),
      new Promise<void>((resolve: () => void): void => {
        timeout = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
