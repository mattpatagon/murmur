import { mock } from "bun:test";
import process from "node:process";
import { z } from "zod";

import type { LoadDatabaseStats, LoadTenant } from "../../scripts/lib/hosted-load-fixture.js";

const mode: string = z
  .enum([
    "child-failure-live",
    "child-failure-idle",
    "fixture-failure-live",
    "fixture-failure-idle",
    "workload-failure-clean",
  ])
  .parse(process.env["MURMUR_TEST_LOAD_DEADLINE_CASE"]);
const originalTimeout: typeof setTimeout = globalThis.setTimeout;
Reflect.set(
  globalThis,
  "setTimeout",
  (run: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
    if (milliseconds !== 240_000) return originalTimeout(run, milliseconds);
    process.stdout.write("hard-deadline:240000\n");
    // Scale only the real verifier's hard timer in this isolated subprocess.
    return originalTimeout(run, mode.endsWith("idle") ? 30_000 : 40);
  },
);

function retainHandle(): void {
  setInterval((): void => {}, 10_000);
}

class Fixture {
  public readonly tenants: readonly LoadTenant[] = [];

  public async verify(): Promise<void> {}
  public async seed(): Promise<void> {}
  public async stats(): Promise<LoadDatabaseStats> {
    return {
      tenants: 128,
      tokens: 128,
      agents: 0,
      messages: 0,
      unreadMessages: 0,
      databaseBytes: 0,
      schemaBytes: 0,
    };
  }
  public async close(): Promise<void> {
    process.stdout.write("fixture-close-attempted\n");
    if (mode === "fixture-failure-live") retainHandle();
    if (mode.startsWith("fixture-failure")) throw new Error("Synthetic fixture shutdown failure");
    if (mode === "workload-failure-clean") {
      originalTimeout((): void => {
        process.stdout.write("clean-drain-complete\n");
      }, 100);
    }
  }
}

class Server {
  public readonly peakRssBytes: number = 1;

  public async url(): Promise<URL> {
    return new URL("http://127.0.0.1:1/mcp");
  }
  public async close(): Promise<void> {
    process.stdout.write("child-close-attempted\n");
    if (mode === "child-failure-live") retainHandle();
    if (mode.startsWith("child-failure")) throw new Error("Synthetic child shutdown failure");
  }
}

class Scenarios {
  public readonly currentPhase: string = "deadline-fixture";
  public readonly exercised: Set<number> = new Set<number>();
  public readonly reports: readonly unknown[] = [];

  public async ramp(): Promise<void> {
    throw new Error("VERIFIER_PRIVATE_SENTINEL");
  }
}

mock.module("../../scripts/lib/hosted-load-fixture.js", (): unknown => ({
  HostedLoadFixture: Fixture,
}));
mock.module("../../scripts/lib/hosted-load-server.js", (): unknown => ({
  HostedLoadServer: Server,
}));
mock.module("../../scripts/lib/hosted-load-scenarios.js", (): unknown => ({
  HostedLoadScenarios: Scenarios,
}));
