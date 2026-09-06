import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export const MAX_RESOURCE_MUTATIONS_PER_SESSION: number = 16;

type Mutation = {
  readonly execute: () => Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
};

export class ResourceMutationQueue {
  private active: Mutation | null = null;
  private activeCompletion: Promise<void> = Promise.resolve();
  private closed: boolean = false;
  private readonly queued: Set<Mutation> = new Set<Mutation>();

  public get outstanding(): number {
    return this.queued.size + (this.active === null ? 0 : 1);
  }

  public run<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.closed)
      return Promise.reject(new McpError(ErrorCode.InvalidRequest, "Session is closed."));
    if (signal.aborted) return Promise.reject(this.canceled());
    if (this.outstanding >= MAX_RESOURCE_MUTATIONS_PER_SESSION) {
      return Promise.reject(
        new McpError(
          ErrorCode.InvalidRequest,
          `Inbox mutation capacity reached (${MAX_RESOURCE_MUTATIONS_PER_SESSION} per session).`,
        ),
      );
    }
    return new Promise<T>(
      (resolve: (value: T | PromiseLike<T>) => void, reject: (error: unknown) => void): void => {
        const mutation: Mutation = {
          execute: async (): Promise<void> => {
            if (this.closed) throw new McpError(ErrorCode.InvalidRequest, "Session is closed.");
            if (signal.aborted) throw this.canceled();
            const result: T = await action();
            if (signal.aborted) throw this.canceled();
            resolve(result);
          },
          onAbort: (): void => this.cancel(mutation, this.canceled()),
          reject,
          signal,
        };
        this.queued.add(mutation);
        signal.addEventListener("abort", mutation.onAbort, { once: true });
        this.advance();
      },
    );
  }

  private canceled(): McpError {
    return new McpError(ErrorCode.InvalidRequest, "Inbox mutation request was canceled.");
  }

  private cancel(mutation: Mutation, error: McpError): void {
    this.queued.delete(mutation);
    mutation.signal.removeEventListener("abort", mutation.onAbort);
    // The server-handler promise also owns global processing capacity until active work settles.
    if (mutation !== this.active) mutation.reject(error);
  }

  private advance(): void {
    if (this.closed || this.active !== null) return;
    const mutation: Mutation | undefined = this.queued.values().next().value;
    if (mutation === undefined) return;
    this.queued.delete(mutation);
    this.active = mutation;
    this.activeCompletion = Promise.resolve()
      .then(mutation.execute)
      .catch(mutation.reject)
      .then((): void => {
        mutation.signal.removeEventListener("abort", mutation.onAbort);
        this.active = null;
        this.advance();
      });
  }

  public close(): Promise<void> {
    this.closed = true;
    for (const mutation of this.queued) {
      this.cancel(mutation, new McpError(ErrorCode.InvalidRequest, "Session is closed."));
    }
    return this.activeCompletion;
  }
}
