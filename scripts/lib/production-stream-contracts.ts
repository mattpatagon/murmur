import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export const PRODUCTION_STREAM_POLICY: ProductionStreamPolicy = Object.freeze({
  minimumWindowMs: 55 * 60_000,
  maximumWindowMs: 56 * 60_000,
  earliestReconnectMs: 49.5 * 60_000,
  healthIntervalMs: 60_000,
  pollIntervalMs: 1_000,
  requestTimeoutMs: 20_000,
});

export type ProductionStreamPolicy = {
  readonly minimumWindowMs: number;
  readonly maximumWindowMs: number;
  readonly earliestReconnectMs: number;
  readonly healthIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly requestTimeoutMs: number;
};

export type ProductionStreamClock = {
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type ProductionStreamConfig = {
  readonly endpoint: URL;
  readonly expectedSha: string;
  readonly expectedVersion: string;
  readonly operatorToken: string;
};

export type ProductionStreamRuntime = {
  readonly fetch: FetchLike;
  readonly clock: ProductionStreamClock;
};

export type ProductionStreamSnapshot = {
  readonly initializationAttempts: number;
  readonly successfulInitializations: number;
  readonly successfulGets: number;
  readonly sessionHash: string | null;
  readonly firstGetAt: number | null;
  readonly firstGetTimestamp: string | null;
  readonly reconnectAt: number | null;
  readonly reconnectTimestamp: string | null;
  readonly initialRequestId: string | null;
  readonly replacementRequestId: string | null;
  readonly invalid: boolean;
};

export type ProductionStreamSession = {
  readonly start: (signal: AbortSignal) => Promise<void>;
  readonly subscribe: (signal: AbortSignal) => Promise<void>;
  readonly keepAlive: (signal: AbortSignal) => Promise<void>;
  readonly snapshot: () => ProductionStreamSnapshot;
  readonly proveDelivery: (signal: AbortSignal) => Promise<void>;
  readonly close: (signal: AbortSignal) => Promise<void>;
};

export type ProductionStreamObservation = {
  readonly session_hash: string;
  readonly stream_started_at: string;
  readonly reconnected_at: string;
  readonly stream_closed_at: string;
  readonly observed_ms: number;
  readonly successful_sse_gets: number;
  readonly initialization_count: number;
  readonly initial_request_id: string;
  readonly replacement_request_id: string;
  readonly health_checks: number;
  readonly real_window_passed: true;
  readonly same_session_reconnect_passed: true;
  readonly post_reconnect_notification_passed: true;
  readonly durable_inbox_passed: true;
  readonly deliberate_stream_close_passed: true;
};

export type ProductionStreamCleanup = {
  readonly worker_revoked: boolean;
  readonly worker_unauthorized: boolean;
  readonly administrator_revoked: boolean;
  readonly administrator_unauthorized: boolean;
  readonly tenant_suspended: boolean;
  readonly connections_closed: boolean;
};

export type ProductionStreamResult = {
  readonly event: "production-stream-result";
  readonly passed: boolean;
  readonly expectedSha: string;
  readonly expectedVersion: string;
  readonly startedAt: string | null;
  readonly endedAt: string;
  readonly observedMilliseconds: number;
  readonly sessionHash: string | null;
  readonly initialRequestId: string | null;
  readonly replacementRequestId: string | null;
  readonly successfulGetResponses: number;
  readonly initializationCount: number;
  readonly sameSession: boolean;
  readonly notification: boolean;
  readonly durableInbox: boolean;
  readonly streamClosed: boolean;
  readonly cleanupPassed: boolean;
  readonly cleanup: ProductionStreamCleanup;
  readonly failure: "Production stream verification failed" | null;
};

export class ProductionStreamFailure extends Error {
  public constructor() {
    super("Production stream verification failed");
    this.name = "ProductionStreamFailure";
  }
}

export function requireProductionStream(condition: unknown): asserts condition {
  if (!condition) throw new ProductionStreamFailure();
}
