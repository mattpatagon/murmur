import {
  type ProductionStreamClock,
  type ProductionStreamObservation,
  type ProductionStreamPolicy,
  type ProductionStreamSession,
  type ProductionStreamSnapshot,
  requireProductionStream,
} from "./production-stream-contracts.js";
import { streamDeadline } from "./production-stream-io.js";

export async function observeProductionStream(
  session: ProductionStreamSession,
  health: (signal: AbortSignal) => Promise<void>,
  clock: ProductionStreamClock,
  policy: ProductionStreamPolicy,
  signal: AbortSignal,
): Promise<ProductionStreamObservation> {
  requireProductionStream(
    policy.minimumWindowMs > 0 &&
      policy.maximumWindowMs > policy.minimumWindowMs &&
      policy.earliestReconnectMs >= 0 &&
      policy.earliestReconnectMs <= policy.minimumWindowMs &&
      policy.healthIntervalMs > 0 &&
      policy.pollIntervalMs > 0,
  );
  let healthChecks: number = 0;
  let connected: boolean = false;
  const checkHealth: () => Promise<void> = async (): Promise<void> => {
    await streamDeadline(
      async (bounded: AbortSignal): Promise<void> => await health(bounded),
      policy.requestTimeoutMs,
      signal,
    );
    if (connected)
      await streamDeadline(
        async (bounded: AbortSignal): Promise<void> => await session.keepAlive(bounded),
        policy.requestTimeoutMs,
        signal,
      );
    healthChecks += 1;
  };
  await checkHealth();
  await streamDeadline(
    async (bounded: AbortSignal): Promise<void> => await session.start(bounded),
    policy.requestTimeoutMs,
    signal,
  );
  connected = true;
  await streamDeadline(
    async (bounded: AbortSignal): Promise<void> => await session.subscribe(bounded),
    policy.requestTimeoutMs,
    signal,
  );
  const initial: ProductionStreamSnapshot = session.snapshot();
  requireProductionStream(
    !initial.invalid &&
      initial.initializationAttempts === 1 &&
      initial.successfulInitializations === 1 &&
      initial.successfulGets === 1 &&
      initial.firstGetAt !== null &&
      initial.firstGetTimestamp !== null &&
      initial.sessionHash !== null,
  );
  const started: number = initial.firstGetAt;
  let nextHealth: number = clock.now() + policy.healthIntervalMs;
  let current: ProductionStreamSnapshot = initial;
  while (true) {
    signal.throwIfAborted();
    current = session.snapshot();
    requireProductionStream(
      !current.invalid &&
        current.initializationAttempts === 1 &&
        current.successfulInitializations === 1 &&
        current.sessionHash === initial.sessionHash &&
        clock.now() - started <= policy.maximumWindowMs,
    );
    if (current.reconnectAt !== null) {
      requireProductionStream(current.reconnectAt - started >= policy.earliestReconnectMs);
    }
    if (clock.now() >= nextHealth) {
      await checkHealth();
      nextHealth = clock.now() + policy.healthIntervalMs;
    }
    if (clock.now() - started >= policy.minimumWindowMs && current.successfulGets >= 2) break;
    await clock.sleep(
      Math.min(policy.pollIntervalMs, policy.maximumWindowMs - (clock.now() - started) + 1),
      signal,
    );
  }
  requireProductionStream(
    current.reconnectTimestamp !== null &&
      current.initialRequestId !== null &&
      current.replacementRequestId !== null &&
      current.initialRequestId !== current.replacementRequestId,
  );
  await streamDeadline(
    async (bounded: AbortSignal): Promise<void> => await session.proveDelivery(bounded),
    policy.requestTimeoutMs,
    signal,
  );
  await checkHealth();
  const final: ProductionStreamSnapshot = session.snapshot();
  requireProductionStream(
    !final.invalid &&
      final.initializationAttempts === 1 &&
      final.successfulInitializations === 1 &&
      final.sessionHash === initial.sessionHash &&
      final.successfulGets === 2,
  );
  await streamDeadline(
    async (bounded: AbortSignal): Promise<void> => await session.close(bounded),
    policy.requestTimeoutMs,
    signal,
  );
  return {
    session_hash: initial.sessionHash,
    stream_started_at: initial.firstGetTimestamp,
    reconnected_at: current.reconnectTimestamp,
    stream_closed_at: clock.timestamp(),
    observed_ms: Math.floor(clock.now() - started),
    successful_sse_gets: final.successfulGets,
    initialization_count: final.successfulInitializations,
    initial_request_id: current.initialRequestId,
    replacement_request_id: current.replacementRequestId,
    health_checks: healthChecks,
    real_window_passed: true,
    same_session_reconnect_passed: true,
    post_reconnect_notification_passed: true,
    durable_inbox_passed: true,
    deliberate_stream_close_passed: true,
  };
}
