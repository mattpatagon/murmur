import { logSafeError } from "../safe-errors.js";
import type {
  HttpCapacityController,
  StreamCapacityReservation,
  TimeSource,
} from "./http-capacity.js";
import type { HttpServerConfig } from "./http-config.js";
import { isOwnerTenant } from "./owner-capacity-policy.js";
import type { RemoteSession, StandaloneStream } from "./remote-session.js";

const MAX_RETIREMENT_WAITERS: number = 64;
const STREAM_RETIREMENT_WAIT_MS: number = 1_000;

type ReleaseWaiter = {
  readonly finished: Promise<boolean>;
  readonly cancel: () => void;
};

export class OwnerStreamAdmissionController {
  private readonly retiring: WeakSet<StandaloneStream> = new WeakSet<StandaloneStream>();
  private readonly waiters: Set<(released: boolean) => void> = new Set<
    (released: boolean) => void
  >();
  private stopped: boolean = false;

  public constructor(
    private readonly capacity: HttpCapacityController,
    private readonly sessions: ReadonlyMap<string, RemoteSession>,
    private readonly config: HttpServerConfig,
    private readonly time: TimeSource,
  ) {}

  private tracked(reservation: StreamCapacityReservation): StreamCapacityReservation {
    if (reservation.kind === "rejected") return reservation;
    let released: boolean = false;
    return {
      kind: "reserved",
      release: (): void => {
        if (released) return;
        released = true;
        reservation.release();
        // Wake only after the real response has released its physical stream charge.
        for (const wake of Array.from(this.waiters)) wake(true);
      },
    };
  }

  private oldestStream(): RemoteSession | null {
    let selected: RemoteSession | null = null;
    let selectedId: string = "";
    let openedAt: number = Number.POSITIVE_INFINITY;
    for (const [id, session] of this.sessions) {
      const stream: StandaloneStream | undefined = session.standaloneStream;
      if (stream === undefined || this.retiring.has(stream)) continue;
      if (stream.openedAt < openedAt || (stream.openedAt === openedAt && id < selectedId)) {
        selected = session;
        selectedId = id;
        openedAt = stream.openedAt;
      }
    }
    return selected;
  }

  private waitForRelease(signal: AbortSignal | undefined): ReleaseWaiter | null {
    if (this.waiters.size >= MAX_RETIREMENT_WAITERS || (signal !== undefined && signal.aborted))
      return null;
    let finish: (released: boolean) => void = (): void => {};
    let cancelTimer: () => void = (): void => {};
    const abort: () => void = (): void => finish(false);
    const finished: Promise<boolean> = new Promise((resolve: (released: boolean) => void): void => {
      finish = (released: boolean): void => {
        if (!this.waiters.delete(finish)) return;
        cancelTimer();
        if (signal !== undefined) signal.removeEventListener("abort", abort);
        resolve(released);
      };
      this.waiters.add(finish);
      if (signal !== undefined) signal.addEventListener("abort", abort, { once: true });
      cancelTimer = this.time.schedule(STREAM_RETIREMENT_WAIT_MS, (): void => finish(false));
    });
    return { finished, cancel: (): void => finish(false) };
  }

  public async reserve(
    principalIdentity: string,
    tenantId: string | null,
    requestedSessionId: string | null,
    signal?: AbortSignal,
  ): Promise<StreamCapacityReservation> {
    if (this.stopped || (signal !== undefined && signal.aborted))
      return { kind: "rejected", scope: "global" };
    const initial: StreamCapacityReservation = this.capacity.reserveStream(
      principalIdentity,
      tenantId,
    );
    if (initial.kind === "reserved") return this.tracked(initial);
    if (!isOwnerTenant(this.config.ownerPriority, tenantId) || requestedSessionId === null)
      return initial;
    const requested: RemoteSession | undefined = this.sessions.get(requestedSessionId);
    if (
      requested === undefined ||
      requested.principalIdentity !== principalIdentity ||
      requested.standaloneStream !== undefined
    )
      return initial;
    const waiter: ReleaseWaiter | null = this.waitForRelease(signal);
    if (waiter === null) return initial;
    const candidate: RemoteSession | null = this.oldestStream();
    const stream: StandaloneStream | undefined =
      candidate === null ? undefined : candidate.standaloneStream;
    try {
      if (candidate !== null && stream !== undefined) {
        this.retiring.add(stream);
        candidate.transport.closeStandaloneSSEStream();
      }
      if (!(await waiter.finished) || this.stopped) return initial;
      return this.tracked(this.capacity.reserveStream(principalIdentity, tenantId));
    } catch (error: unknown) {
      logSafeError("Murmur owner stream retirement failed", error);
      return initial;
    } finally {
      waiter.cancel();
      if (stream !== undefined) this.retiring.delete(stream);
    }
  }

  public stop(): void {
    this.stopped = true;
    for (const wake of Array.from(this.waiters)) wake(false);
  }
}
