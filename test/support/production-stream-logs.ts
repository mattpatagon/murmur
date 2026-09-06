import { expect } from "bun:test";

import {
  STREAM_LOG_MAX_BYTES,
  type StreamLogConfiguration,
  type StreamLogContext,
  type StreamLogResult,
} from "../../scripts/lib/production-stream-log-contracts.js";
import type { StreamLogRuntime } from "../../scripts/lib/production-stream-log-process.js";
import type { StreamApplicationLog } from "../../scripts/lib/production-stream-log-queries.js";
import { preflightProductionStreamLogs } from "../../scripts/lib/production-stream-log-verifier.js";

const BASE: number = Date.parse("2026-09-06T00:00:00.000Z");
export const START: number = 5_000;
export const END: number = START + 55 * 60_000;
export const SHA: string = "a".repeat(40);
export const REVISION: string = "murmur-00042-abc";
export const CONFIG: StreamLogConfiguration = {
  project: "murmur-project",
  region: "us-central1",
  service: "murmur",
  repository: "application",
  expectedSha: SHA,
  expectedVersion: "0.14.0.0",
  origin: "https://api.example.com",
};
export const INITIAL_ID: string = "0478ebfe-f07c-407f-b98b-67dce4f2c22e";
export const REPLACEMENT_ID: string = "75373393-8c5e-4c61-a7c9-949dfdce6f65";

export function timestamp(offset: number): string {
  return new Date(BASE + offset).toISOString();
}
export function result(): StreamLogResult {
  return {
    event: "production-stream-result",
    passed: true,
    expectedSha: SHA,
    expectedVersion: CONFIG.expectedVersion,
    startedAt: timestamp(START),
    endedAt: timestamp(END),
    observedMilliseconds: 55 * 60_000,
    sessionHash: "h".repeat(22),
    initialRequestId: INITIAL_ID,
    replacementRequestId: REPLACEMENT_ID,
    successfulGetResponses: 2,
    initializationCount: 1,
    sameSession: true,
    notification: true,
    durableInbox: true,
    streamClosed: true,
    cleanupPassed: true,
    cleanup: {
      worker_revoked: true,
      worker_unauthorized: true,
      administrator_revoked: true,
      administrator_unauthorized: true,
      tenant_suspended: true,
      connections_closed: true,
    },
    failure: null,
  };
}
export function applicationLog(initial: boolean): StreamApplicationLog {
  return {
    timestamp: timestamp(initial ? START + 50 * 60_000 : END),
    resource: {
      type: "cloud_run_revision",
      labels: {
        project_id: CONFIG.project,
        location: CONFIG.region,
        service_name: CONFIG.service,
        revision_name: REVISION,
      },
    },
    jsonPayload: {
      event: "http.request.completed",
      http_method: "GET",
      http_route: "/mcp",
      http_status_code: 200,
      response_finish: initial ? "completed" : "cancelled",
      session_hash: result().sessionHash,
      request_id: initial ? INITIAL_ID : REPLACEMENT_ID,
      session_lookup: "found",
      authentication: "authenticated",
      principal_kind: "tenant",
      stream_rotated: initial,
      duration_ms: initial ? 50 * 60_000 : 5 * 60_000 - 1_000,
    },
  };
}

export class LogFixture implements StreamLogRuntime {
  public elapsed: number = 0;
  public readonly calls: { readonly arguments: readonly string[]; readonly timeoutMs: number }[] =
    [];
  public readonly sleeps: number[] = [];
  public service: unknown = {
    metadata: { name: "murmur" },
    status: {
      latestReadyRevisionName: REVISION,
      traffic: [{ revisionName: REVISION, percent: 100 }],
    },
  };
  public image: unknown = {
    metadata: { name: REVISION },
    spec: {
      containers: [
        {
          image: `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/${CONFIG.repository}/murmur:${SHA}@sha256:${"b".repeat(64)}`,
        },
      ],
    },
  };
  public releaseValue: unknown = { revision: SHA, version: CONFIG.expectedVersion };
  public initial: unknown = [applicationLog(true)];
  public replacement: unknown = [applicationLog(false)];
  public platform: unknown = [];
  public access: unknown = [];
  public fail: boolean = false;
  public oversize: boolean = false;
  public initialMisses: number = 0;
  public perCallMs: number = 0;
  public readonly now: () => number = (): number => this.elapsed;
  public readonly timestamp: () => string = (): string => timestamp(this.elapsed);
  public readonly sleep: (milliseconds: number) => Promise<void> = async (
    milliseconds: number,
  ): Promise<void> => {
    this.sleeps.push(milliseconds);
    this.elapsed += milliseconds;
  };
  public readonly release: (origin: string, timeoutMs: number) => Promise<unknown> = async (
    origin: string,
    timeoutMs: number,
  ): Promise<unknown> => {
    expect(origin).toBe(CONFIG.origin);
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(10_000);
    return this.releaseValue;
  };
  public readonly execute: (arguments_: readonly string[], timeoutMs: number) => Promise<string> =
    async (arguments_: readonly string[], timeoutMs: number): Promise<string> => {
      this.calls.push({ arguments: [...arguments_], timeoutMs });
      this.elapsed += this.perCallMs;
      if (this.fail) throw new Error("private-token-sentinel raw subprocess stderr");
      if (this.oversize) return " ".repeat(STREAM_LOG_MAX_BYTES + 1);
      if (arguments_[0] === "run")
        return JSON.stringify(arguments_[1] === "services" ? this.service : this.image);
      const filter: string | undefined = arguments_[2];
      if (filter === undefined) throw new Error("Missing fixture filter");
      if (filter.includes(INITIAL_ID)) {
        if (this.initialMisses > 0) {
          this.initialMisses -= 1;
          return "[]";
        }
        return JSON.stringify(this.initial);
      }
      if (filter.includes(REPLACEMENT_ID)) return JSON.stringify(this.replacement);
      return JSON.stringify(
        filter.includes("httpRequest.status>=500") ? this.platform : this.access,
      );
    };
  public async ready(): Promise<StreamLogContext> {
    const context: StreamLogContext = await preflightProductionStreamLogs(CONFIG, this);
    this.elapsed = END + 120_000;
    return context;
  }
}
