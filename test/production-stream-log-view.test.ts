import { expect, test } from "bun:test";

import {
  ProductionStreamLogFailure,
  type StreamLogContext,
} from "../scripts/lib/production-stream-log-contracts.js";
import type { StreamLogRuntime } from "../scripts/lib/production-stream-log-process.js";
import {
  preflightProductionStreamLogs,
  verifyProductionStreamLogs,
} from "../scripts/lib/production-stream-log-verifier.js";
import { CONFIG, END, LogFixture, result } from "./support/production-stream-logs.js";

function argument(arguments_: readonly string[], flag: string): string | undefined {
  const index: number = arguments_.indexOf(flag);
  return index < 0 ? undefined : arguments_[index + 1];
}

function viewRuntime(
  fixture: LogFixture,
  queries: (readonly string[])[],
  denied: boolean,
): StreamLogRuntime {
  return {
    now: fixture.now,
    timestamp: fixture.timestamp,
    sleep: fixture.sleep,
    release: fixture.release,
    execute: async (arguments_: readonly string[], timeoutMs: number): Promise<string> => {
      if (arguments_[0] === "logging") {
        queries.push([...arguments_]);
        // Model view-level access: a project-wide read is denied even with a matching filter.
        if (
          denied ||
          argument(arguments_, "--project") !== CONFIG.project ||
          argument(arguments_, "--location") !== "global" ||
          argument(arguments_, "--bucket") !== "_Default" ||
          argument(arguments_, "--view") !== CONFIG.service
        ) {
          throw new Error("private-log-access-denial-sentinel");
        }
      }
      return await fixture.execute(arguments_, timeoutMs);
    },
  };
}

test("view-only log access supports preflight, rotation, reconnect, and platform checks", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const queries: (readonly string[])[] = [];
  const runtime: StreamLogRuntime = viewRuntime(fixture, queries, false);
  const context: StreamLogContext = await preflightProductionStreamLogs(CONFIG, runtime);
  fixture.elapsed = END + 120_000;
  const verified: Awaited<ReturnType<typeof verifyProductionStreamLogs>> =
    await verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), runtime);
  expect(verified.application_rotation).toBe(true);
  expect(verified.same_session_reconnect).toBe(true);
  expect(verified.platform_5xx_absent_in_observed_window).toBe(true);
  expect(queries).toHaveLength(4);
  for (const query of queries) {
    expect(argument(query, "--limit")).toBe("2");
    expect(query).not.toContain("--resource-names");
    expect(query).not.toContain("--impersonate-service-account");
    for (const flag of ["--project", "--location", "--bucket", "--view"]) {
      expect(query.indexOf(flag)).toBe(query.lastIndexOf(flag));
    }
  }
});

test("denied view access fails safely without retrying a broader logging scope", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const queries: (readonly string[])[] = [];
  await expect(
    preflightProductionStreamLogs(CONFIG, viewRuntime(fixture, queries, true)),
  ).rejects.toThrow(new ProductionStreamLogFailure());
  expect(queries).toHaveLength(1);
  const query: readonly string[] | undefined = queries[0];
  if (query === undefined) throw new Error("Missing denied log-view query");
  expect(argument(query, "--project")).toBe(CONFIG.project);
  expect(argument(query, "--location")).toBe("global");
  expect(argument(query, "--bucket")).toBe("_Default");
  expect(argument(query, "--view")).toBe(CONFIG.service);
});
