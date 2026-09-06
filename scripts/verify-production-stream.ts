import process from "node:process";

import {
  PRODUCTION_STREAM_POLICY,
  type ProductionStreamCleanup,
  type ProductionStreamConfig,
  type ProductionStreamObservation,
  type ProductionStreamResult,
  type ProductionStreamRuntime,
  type ProductionStreamSnapshot,
} from "./lib/production-stream-contracts.js";
import { ProductionStreamFixture } from "./lib/production-stream-fixture.js";
import {
  checkProductionStreamHealth,
  productionStreamConfig,
} from "./lib/production-stream-health.js";
import { PRODUCTION_STREAM_CLOCK, streamDeadline } from "./lib/production-stream-io.js";
import { observeProductionStream } from "./lib/production-stream-observer.js";
import { ProductionStreamAgent } from "./lib/production-stream-session.js";

export const PRODUCTION_STREAM_TOTAL_DEADLINE_MS: number = 60 * 60_000;
export const PRODUCTION_STREAM_WORK_DEADLINE_MS: number = 57 * 60_000;

export async function runProductionStream(
  config: ProductionStreamConfig,
  runtime: ProductionStreamRuntime,
): Promise<ProductionStreamResult> {
  const started: number = runtime.clock.now();
  const fixture: ProductionStreamFixture = new ProductionStreamFixture(config, runtime);
  let agent: ProductionStreamAgent | null = null;
  let observation: ProductionStreamObservation | null = null;
  let failed: boolean = false;
  let streamClosed: boolean = false;
  let cleanup: ProductionStreamCleanup = {
    worker_revoked: false,
    worker_unauthorized: false,
    administrator_revoked: false,
    administrator_unauthorized: false,
    tenant_suspended: false,
    connections_closed: false,
  };
  const hardDeadline: ReturnType<typeof setTimeout> = setTimeout((): never => {
    process.stderr.write("Production stream verification failed\n");
    process.exit(1);
  }, PRODUCTION_STREAM_TOTAL_DEADLINE_MS);
  hardDeadline.unref();
  const progress: ReturnType<typeof setInterval> = setInterval((): void => {
    const snapshot: ProductionStreamSnapshot | null = agent === null ? null : agent.snapshot();
    if (snapshot === null || snapshot.firstGetAt === null) return;
    process.stdout.write(
      `${JSON.stringify({
        event: "production-stream-progress",
        elapsedMilliseconds: Math.floor(runtime.clock.now() - snapshot.firstGetAt),
      })}\n`,
    );
  }, 60_000);
  try {
    const token: string = await streamDeadline(async (signal: AbortSignal): Promise<string> => {
      await checkProductionStreamHealth(config, runtime, signal);
      return await fixture.provision(signal);
    }, 75_000);
    agent = new ProductionStreamAgent(config.endpoint, token, runtime);
    const observed: ProductionStreamAgent = agent;
    observation = await streamDeadline(
      async (signal: AbortSignal): Promise<ProductionStreamObservation> =>
        await observeProductionStream(
          observed,
          async (healthSignal: AbortSignal): Promise<void> =>
            await checkProductionStreamHealth(config, runtime, healthSignal),
          runtime.clock,
          PRODUCTION_STREAM_POLICY,
          signal,
        ),
      Math.max(1, PRODUCTION_STREAM_WORK_DEADLINE_MS - (runtime.clock.now() - started)),
    );
    streamClosed = true;
  } catch (_error: unknown) {
    failed = true;
  } finally {
    clearInterval(progress);
    if (agent !== null) {
      const closing: ProductionStreamAgent = agent;
      try {
        await streamDeadline(
          async (signal: AbortSignal): Promise<void> => await closing.close(signal),
          25_000,
        );
        streamClosed = true;
      } catch (_error: unknown) {
        failed = true;
      }
    }
    try {
      cleanup = await fixture.cleanup();
    } catch (_error: unknown) {
      failed = true;
    }
  }
  const cleanupPassed: boolean = Object.values(cleanup).every((value: boolean): boolean => value);
  if (cleanupPassed) clearTimeout(hardDeadline);
  const snapshot: ProductionStreamSnapshot | null = agent === null ? null : agent.snapshot();
  return {
    event: "production-stream-result",
    passed: !failed && observation !== null && cleanupPassed,
    expectedSha: config.expectedSha,
    expectedVersion: config.expectedVersion,
    startedAt: snapshot === null ? null : snapshot.firstGetTimestamp,
    endedAt: observation === null ? runtime.clock.timestamp() : observation.stream_closed_at,
    observedMilliseconds: observation === null ? 0 : observation.observed_ms,
    sessionHash: snapshot === null ? null : snapshot.sessionHash,
    initialRequestId: snapshot === null ? null : snapshot.initialRequestId,
    replacementRequestId: snapshot === null ? null : snapshot.replacementRequestId,
    successfulGetResponses: snapshot === null ? 0 : snapshot.successfulGets,
    initializationCount: snapshot === null ? 0 : snapshot.successfulInitializations,
    sameSession: observation !== null,
    notification: observation !== null,
    durableInbox: observation !== null,
    streamClosed,
    cleanupPassed,
    cleanup,
    failure:
      failed || observation === null || !cleanupPassed
        ? "Production stream verification failed"
        : null,
  };
}

async function main(): Promise<void> {
  try {
    const config: ProductionStreamConfig = productionStreamConfig(process.env);
    const result: ProductionStreamResult = await runProductionStream(config, {
      fetch,
      clock: PRODUCTION_STREAM_CLOCK,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (_error: unknown) {
    process.stderr.write("Production stream verification failed\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
