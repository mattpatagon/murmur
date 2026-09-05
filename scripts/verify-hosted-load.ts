#!/usr/bin/env bun

import process from "node:process";

import {
  type HostedLoadConfig,
  HostedLoadFailure,
  loadConfig,
  requireLoad,
} from "./lib/hosted-load-config.js";
import {
  HostedLoadFixture,
  type LoadDatabaseStats,
  type LoadTenant,
} from "./lib/hosted-load-fixture.js";
import { HostedLoadScenarios } from "./lib/hosted-load-scenarios.js";
import { HostedLoadServer } from "./lib/hosted-load-server.js";

async function main(): Promise<void> {
  const config: HostedLoadConfig = loadConfig(process.env);
  const started: number = performance.now();
  const controller: AbortController = new AbortController();
  const deadline: ReturnType<typeof setTimeout> = setTimeout(
    (): void => controller.abort(),
    config.durationSeconds * 1_000,
  );
  const hardDeadline: ReturnType<typeof setTimeout> = setTimeout(
    (): never => {
      process.stderr.write("Hosted load hard deadline exceeded\n");
      process.exit(1);
    },
    (config.durationSeconds + 120) * 1_000,
  );
  const fixture: HostedLoadFixture = new HostedLoadFixture(config);
  let server: HostedLoadServer | null = null;
  let scenarios: HostedLoadScenarios | null = null;
  let baseline: LoadDatabaseStats | null = null;
  let seeded: LoadDatabaseStats | null = null;
  let loaded: LoadDatabaseStats | null = null;
  let stage: string = "database-preflight";
  let passed: boolean = false;
  let failure: string | null = null;
  let cleanupPassed: boolean = true;
  const heartbeat: ReturnType<typeof setInterval> = setInterval((): void => {
    process.stdout.write(
      `${JSON.stringify({
        event: "hosted-load-progress",
        stage: scenarios === null ? stage : scenarios.currentPhase,
        elapsedSeconds: Math.round((performance.now() - started) / 1_000),
        exercisedAccounts: scenarios === null ? 0 : scenarios.exercised.size,
        peakAppRssBytes: server === null ? 0 : server.peakRssBytes,
      })}\n`,
    );
  }, 30_000);
  try {
    await fixture.verify();
    baseline = await fixture.stats();
    stage = "seed-accounts";
    await fixture.seed(controller.signal);
    seeded = await fixture.stats();
    requireLoad(
      seeded.tenants === config.tenantCount && seeded.tokens === config.tenantCount,
      "Load account seeding did not reach the requested population",
    );
    stage = "start-hosted-child";
    server = new HostedLoadServer(config);
    const url: URL = await server.url();
    scenarios = new HostedLoadScenarios(config, fixture.tenants, url, controller.signal, server);
    await scenarios.ramp();
    await scenarios.sessionIsolation();
    await scenarios.maliciousTraffic(false);
    await scenarios.maliciousTraffic(true);
    await scenarios.accounts();
    await scenarios.saturation();
    stage = "database-verification";
    scenarios.currentPhase = stage;
    const first: LoadTenant | undefined = fixture.tenants[0];
    const last: LoadTenant | undefined = fixture.tenants.at(-1);
    requireLoad(first !== undefined && last !== undefined, "Load fixture is empty");
    await fixture.verifyTenantRows(first);
    await fixture.verifyTenantRows(last);
    loaded = await fixture.stats();
    requireLoad(
      loaded.tenants === config.tenantCount &&
        loaded.tokens === config.tenantCount &&
        loaded.agents === config.tenantCount * 2 &&
        loaded.unreadMessages === 0 &&
        scenarios.exercised.size === config.tenantCount,
      "Hosted load did not exercise every account with isolated acknowledged messages",
    );
    server.verifyHealthy();
    passed = true;
  } catch (error: unknown) {
    failure = error instanceof HostedLoadFailure ? error.message : "External operation failed";
    passed = false;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    controller.abort();
    if (server !== null) {
      try {
        await server.close();
      } catch (_error: unknown) {
        cleanupPassed = false;
      }
    }
    try {
      await fixture.close();
    } catch (_error: unknown) {
      cleanupPassed = false;
    }
    clearTimeout(hardDeadline);
    process.stdout.write(
      `${JSON.stringify({
        event: "hosted-load-result",
        passed: passed && cleanupPassed,
        failure,
        cleanupPassed,
        lastStage: scenarios === null ? stage : scenarios.currentPhase,
        durationMs: Math.round(performance.now() - started),
        profile: {
          seededAccounts: config.tenantCount,
          exercisedAccounts: scenarios === null ? 0 : scenarios.exercised.size,
          steadyConcurrency: config.concurrency,
          rampConcurrency: [1, 4, 16, 64],
          attackConcurrency: 66,
          authenticationSlots: 4,
          maxSessions: config.maxSessionCount,
          maxStreams: 64,
          maxAppRssBytes: config.maxRssBytes,
          p95LimitMs: config.p95Ms,
          p99LimitMs: config.p99Ms,
        },
        peakAppRssBytes: server === null ? 0 : server.peakRssBytes,
        database: { baseline, seeded, loaded },
        phases: scenarios === null ? [] : scenarios.reports,
      })}\n`,
    );
    if (!passed || !cleanupPassed) process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((_error: unknown): void => {
    process.stderr.write("Hosted load configuration or verification failed\n");
    process.exitCode = 1;
  });
}
