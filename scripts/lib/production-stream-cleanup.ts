import {
  type ProductionStreamCleanup,
  requireProductionStream,
} from "./production-stream-contracts.js";

export type ProductionStreamCleanupScope = {
  readonly signal: AbortSignal;
  readonly deadline: number;
};
type Action = (scope: ProductionStreamCleanupScope) => Promise<boolean>;
export type ProductionStreamCleanupActions = {
  readonly revokeWorker: Action;
  readonly verifyWorker: Action;
  readonly revokeAdministrator: Action;
  readonly verifyAdministrator: Action;
  readonly suspendTenant: Action;
  readonly closeConnections: Action;
};
export type ProductionStreamCleanupClock = {
  readonly now: () => number;
  readonly schedule: (milliseconds: number, run: () => void) => () => void;
};
export type ProductionStreamCleanupLimits = {
  readonly totalMs: number;
  readonly closeReserveMs: number;
  readonly stepMs: number;
  readonly settleMs: number;
};
const CLOCK: ProductionStreamCleanupClock = {
  now: (): number => performance.now(),
  schedule: (milliseconds: number, run: () => void): (() => void) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(run, milliseconds);
    return (): void => clearTimeout(timer);
  },
};
const LIMITS: ProductionStreamCleanupLimits = {
  totalMs: 150_000,
  closeReserveMs: 30_000,
  stepMs: 45_000,
  settleMs: 2_000,
};
type Outcome = { readonly value: boolean; readonly settled: boolean };

export function productionStreamCleanup(
  actions: ProductionStreamCleanupActions,
  clock: ProductionStreamCleanupClock = CLOCK,
  limits: ProductionStreamCleanupLimits = LIMITS,
): () => Promise<ProductionStreamCleanup> {
  requireProductionStream(
    limits.totalMs > limits.closeReserveMs &&
      limits.closeReserveMs > 0 &&
      limits.stepMs > 0 &&
      limits.settleMs > 0,
  );
  let result: Promise<ProductionStreamCleanup> | null = null;
  const attempt: (action: Action, end: number) => Promise<Outcome> = async (
    action: Action,
    end: number,
  ): Promise<Outcome> => {
    if (clock.now() >= end) return { value: false, settled: true };
    const controller: AbortController = new AbortController();
    let cancel: () => void = (): void => {};
    const timeout: Promise<"expired"> = new Promise<"expired">(
      (resolve: (value: "expired") => void): void => {
        cancel = clock.schedule(end - clock.now(), (): void => {
          controller.abort();
          resolve("expired");
        });
      },
    );
    const task: Promise<boolean> = Promise.resolve()
      .then(async (): Promise<boolean> => {
        controller.signal.throwIfAborted();
        requireProductionStream(clock.now() < end);
        return await action({ signal: controller.signal, deadline: end });
      })
      .catch((_error: unknown): boolean => false);
    const completed: boolean | "expired" = await Promise.race([task, timeout]);
    cancel();
    if (completed !== "expired") return { value: completed, settled: true };
    // Never start another mutation while an aborted predecessor remains unobservably live.
    let cancelSettlement: () => void = (): void => {};
    const unsettled: Promise<false> = new Promise<false>(
      (resolve: (value: false) => void): void => {
        cancelSettlement = clock.schedule(limits.settleMs, (): void => resolve(false));
      },
    );
    const settled: boolean = await Promise.race([task.then((): boolean => true), unsettled]);
    cancelSettlement();
    return { value: false, settled };
  };
  const run: () => Promise<ProductionStreamCleanup> =
    async (): Promise<ProductionStreamCleanup> => {
      const end: number = clock.now() + limits.totalMs;
      const mutationEnd: number = end - limits.closeReserveMs;
      let priorSettled: boolean = true;
      const bounded: (action: Action) => Promise<boolean> = async (
        action: Action,
      ): Promise<boolean> => {
        if (!priorSettled || clock.now() >= mutationEnd) return false;
        const outcome: Outcome = await attempt(
          action,
          Math.min(mutationEnd, clock.now() + limits.stepMs),
        );
        priorSettled = outcome.settled;
        return outcome.value;
      };
      const workerRevoked: boolean = await bounded(actions.revokeWorker);
      const workerUnauthorized: boolean = await bounded(actions.verifyWorker);
      const administratorRevoked: boolean = await bounded(actions.revokeAdministrator);
      const administratorUnauthorized: boolean = await bounded(actions.verifyAdministrator);
      const tenantSuspended: boolean = await bounded(actions.suspendTenant);
      const closed: Outcome = await attempt(actions.closeConnections, end);
      return {
        worker_revoked: workerRevoked || workerUnauthorized,
        worker_unauthorized: workerUnauthorized,
        administrator_revoked: administratorRevoked || administratorUnauthorized,
        administrator_unauthorized: administratorUnauthorized,
        tenant_suspended: tenantSuspended,
        connections_closed: closed.value && closed.settled && priorSettled,
      };
    };
  return (): Promise<ProductionStreamCleanup> => {
    if (result === null) result = run();
    return result;
  };
}
