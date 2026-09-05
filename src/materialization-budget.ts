import { AsyncLocalStorage } from "node:async_hooks";

export class MaterializationCapacityError extends Error {
  public constructor() {
    super("MCP materialization capacity reached; retry later.");
    this.name = "MaterializationCapacityError";
  }
}

function validateBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Materialization byte estimate must be a nonnegative safe integer");
  }
}

type ByteReservation = {
  resize(bytes: number): void;
  release(): void;
};

export class MaterializationByteBudget {
  private readonly maximum: number;
  private used: number = 0;

  public constructor(maximum: number) {
    validateBytes(maximum);
    if (maximum === 0) throw new Error("Materialization byte budget must be positive");
    this.maximum = maximum;
  }

  public get reservedBytes(): number {
    return this.used;
  }

  public reserve(bytes: number): ByteReservation {
    validateBytes(bytes);
    if (bytes > this.maximum - this.used) throw new MaterializationCapacityError();
    this.used += bytes;
    let retained: number = bytes;
    return {
      resize: (next: number): void => {
        validateBytes(next);
        if (next > retained) throw new Error("Materialization reservation cannot grow");
        this.used -= retained - next;
        retained = next;
      },
      release: (): void => {
        this.used -= retained;
        retained = 0;
      },
    };
  }
}

export type MaterializationReservation = {
  /** Call only after the actual query and its boundary validation have settled. */
  settle(actualRetainedBytes: number): void;
  /** Call only after the actual operation failed, never merely because its caller aborted. */
  fail(): void;
};

type ScopedReservation = { readonly bytes: ByteReservation; pending: boolean };

export class MaterializationScope {
  private readonly budget: MaterializationByteBudget;
  private readonly retained: Set<ScopedReservation> = new Set<ScopedReservation>();
  private activeHandlers: number = 0;
  private responseFinished: boolean = false;

  public constructor(budget: MaterializationByteBudget) {
    this.budget = budget;
  }

  public startHandler(): () => void {
    if (this.responseFinished) throw new MaterializationCapacityError();
    this.activeHandlers += 1;
    let finished: boolean = false;
    return (): void => {
      if (finished) return;
      finished = true;
      this.activeHandlers -= 1;
      this.releaseFinished();
    };
  }

  public finishResponse(): void {
    this.responseFinished = true;
    this.releaseFinished();
  }

  private releaseFinished(): void {
    if (!this.responseFinished || this.activeHandlers !== 0) return;
    for (const reservation of this.retained) {
      // An abandoned outer promise must not erase a query that is still in flight.
      if (reservation.pending) continue;
      reservation.bytes.release();
      this.retained.delete(reservation);
    }
  }

  public reserve(maximumBytes: number): MaterializationReservation {
    if (this.responseFinished && this.activeHandlers === 0) {
      throw new MaterializationCapacityError();
    }
    const reservation: ScopedReservation = {
      bytes: this.budget.reserve(maximumBytes),
      pending: true,
    };
    this.retained.add(reservation);
    return {
      settle: (actual: number): void => {
        if (!reservation.pending) return;
        reservation.bytes.resize(actual);
        reservation.pending = false;
        if (actual === 0) {
          reservation.bytes.release();
          this.retained.delete(reservation);
        }
        this.releaseFinished();
      },
      fail: (): void => {
        if (!reservation.pending) return;
        reservation.pending = false;
        reservation.bytes.release();
        this.retained.delete(reservation);
      },
    };
  }

  public reserveTemporary(bytes: number): () => void {
    if (this.responseFinished && this.activeHandlers === 0) {
      throw new MaterializationCapacityError();
    }
    const reservation: ByteReservation = this.budget.reserve(bytes);
    return (): void => reservation.release();
  }
}

const CONTEXT: AsyncLocalStorage<MaterializationScope> =
  new AsyncLocalStorage<MaterializationScope>();

export function withMaterializationScope<T>(scope: MaterializationScope, action: () => T): T {
  return CONTEXT.run(scope, action);
}

export function startMaterializationHandler(): () => void {
  const scope: MaterializationScope | undefined = CONTEXT.getStore();
  return scope === undefined ? (): void => {} : scope.startHandler();
}

export function reserveMaterializationBytes(maximumBytes: number): MaterializationReservation {
  validateBytes(maximumBytes);
  const scope: MaterializationScope | undefined = CONTEXT.getStore();
  if (scope !== undefined) return scope.reserve(maximumBytes);
  // Stdio and storage-only callers keep their page caps without inheriting hosted HTTP policy.
  return {
    settle: (actual: number): void => {
      validateBytes(actual);
      if (actual > maximumBytes) throw new Error("Materialization reservation cannot grow");
    },
    fail: (): void => {},
  };
}

export function reserveTemporaryMaterializationBytes(maximumBytes: number): () => void {
  validateBytes(maximumBytes);
  const scope: MaterializationScope | undefined = CONTEXT.getStore();
  return scope === undefined ? (): void => {} : scope.reserveTemporary(maximumBytes);
}
