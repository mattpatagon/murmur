import { expect } from "bun:test";

import type {
  ProductionStreamCleanup,
  ProductionStreamConfig,
  ProductionStreamRuntime,
  ProductionStreamSnapshot,
} from "../../scripts/lib/production-stream-contracts.js";
import { ProductionStreamFixture } from "../../scripts/lib/production-stream-fixture.js";
import { PRODUCTION_STREAM_CLOCK, streamDeadline } from "../../scripts/lib/production-stream-io.js";
import { ProductionStreamAgent } from "../../scripts/lib/production-stream-session.js";
import type { MurmurHttpServer } from "../../src/http-server.js";

export async function verifyHostedProductionStreamFixture(
  server: MurmurHttpServer,
  operatorToken: string,
): Promise<void> {
  // This local fixture exercises setup and cleanup, not production release or rotation evidence.
  const config: ProductionStreamConfig = {
    endpoint: server.mcpUrl,
    expectedSha: "a".repeat(40),
    expectedVersion: "0.0.0.0",
    operatorToken,
  };
  const runtime: ProductionStreamRuntime = { clock: PRODUCTION_STREAM_CLOCK, fetch };
  const fixture: ProductionStreamFixture = new ProductionStreamFixture(config, runtime);
  let agent: ProductionStreamAgent | null = null;
  try {
    const token: string = await streamDeadline(
      async (signal: AbortSignal): Promise<string> => await fixture.provision(signal),
      60_000,
    );
    agent = new ProductionStreamAgent(server.mcpUrl, token, runtime);
    const active: ProductionStreamAgent = agent;
    await streamDeadline(async (signal: AbortSignal): Promise<void> => {
      await active.start(signal);
      await active.subscribe(signal);
      await active.keepAlive(signal);
      const snapshot: ProductionStreamSnapshot = active.snapshot();
      expect(snapshot.invalid).toBe(false);
      expect(snapshot.successfulInitializations).toBe(1);
      expect(snapshot.initializationAttempts).toBe(1);
      expect(snapshot.successfulGets).toBe(1);
    }, 40_000);
  } finally {
    try {
      if (agent !== null) {
        const closing: ProductionStreamAgent = agent;
        await streamDeadline(
          async (signal: AbortSignal): Promise<void> => await closing.close(signal),
          25_000,
        );
      }
    } finally {
      const cleanup: ProductionStreamCleanup = await fixture.cleanup();
      expect(cleanup).toEqual({
        worker_revoked: true,
        worker_unauthorized: true,
        administrator_revoked: true,
        administrator_unauthorized: true,
        tenant_suspended: true,
        connections_closed: true,
      });
    }
  }
}
