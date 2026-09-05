import { AsyncLocalStorage } from "node:async_hooks";

export type IncomingRequestId = string | number;

export class RequestIdClaim {
  public readonly id: IncomingRequestId;
  private readonly release: (abortedBeforeSend: boolean) => void;
  private dispatched: boolean = false;
  private dispatchFinished: boolean = false;
  private handlerStarted: boolean = false;
  private handlerFinished: boolean = false;
  private responseFinished: boolean = false;
  private sendStarted: boolean = false;
  private sendFinished: boolean = false;
  private released: boolean = false;
  private signal: AbortSignal | null = null;
  private readonly onAbort: () => void = (): void => this.releaseFinished();

  public constructor(id: IncomingRequestId, release: (abortedBeforeSend: boolean) => void) {
    this.id = id;
    this.release = release;
  }

  public markDispatched(): void {
    this.dispatched = true;
  }

  public finishDispatch(): void {
    this.dispatchFinished = true;
    if (!this.dispatched && !this.handlerStarted && !this.sendStarted) this.handlerFinished = true;
    this.releaseFinished();
  }

  public startHandler(signal: AbortSignal): () => void {
    if (this.released || this.handlerStarted)
      throw new Error("Invalid MCP request-ID handler ownership");
    this.handlerStarted = true;
    this.signal = signal;
    signal.addEventListener("abort", this.onAbort, { once: true });
    return (): void => {
      this.handlerFinished = true;
      this.releaseFinished();
    };
  }

  public startSend(): () => void {
    if (this.released || this.sendStarted) throw new Error("Invalid MCP request-ID send ownership");
    // Set synchronously: an abort after this point cannot prove that the SDK skipped sending.
    this.sendStarted = true;
    if (!this.handlerStarted) this.handlerFinished = true;
    return (): void => {
      this.sendFinished = true;
      this.releaseFinished();
    };
  }

  public finishResponse(): void {
    this.responseFinished = true;
    this.releaseFinished();
  }

  private releaseFinished(): void {
    const notDispatched: boolean = this.dispatchFinished && !this.dispatched;
    const abortedBeforeSend: boolean =
      !this.sendStarted && this.signal !== null && this.signal.aborted;
    if (
      this.released ||
      !this.responseFinished ||
      !this.handlerFinished ||
      !(this.sendFinished || abortedBeforeSend || notDispatched)
    )
      return;
    this.released = true;
    if (this.signal !== null) this.signal.removeEventListener("abort", this.onAbort);
    this.release(abortedBeforeSend);
  }
}

const CONTEXT: AsyncLocalStorage<RequestIdClaim | undefined> = new AsyncLocalStorage<
  RequestIdClaim | undefined
>();

export function withRequestIdClaim<T>(claim: RequestIdClaim | undefined, action: () => T): T {
  return CONTEXT.run(claim, action);
}

export function currentRequestIdClaim(): RequestIdClaim | undefined {
  return CONTEXT.getStore();
}

export function startRequestIdHandler(id: IncomingRequestId, signal: AbortSignal): () => void {
  const claim: RequestIdClaim | undefined = currentRequestIdClaim();
  if (claim === undefined) return (): void => {};
  if (claim.id !== id) throw new Error("Invalid MCP request-ID handler ownership");
  return claim.startHandler(signal);
}
