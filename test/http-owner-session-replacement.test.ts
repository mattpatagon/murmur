import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import type { TimeSource } from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";
import {
  type RetirableSession,
  type SessionAdmission,
  SessionAdmissionController,
} from "../src/http/session-admission.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { initializeSession, postJson, testEnvironment } from "./support/http-mcp-harness.js";

class ManualTime implements TimeSource {
  private current: number = 0;
  private readonly timers: Set<{ readonly at: number; readonly wake: () => void }> = new Set<{
    readonly at: number;
    readonly wake: () => void;
  }>();

  public now(): number {
    return this.current;
  }

  public schedule(milliseconds: number, wake: () => void): () => void {
    const timer: { readonly at: number; readonly wake: () => void } = {
      at: this.current + milliseconds,
      wake,
    };
    this.timers.add(timer);
    return (): void => {
      this.timers.delete(timer);
    };
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const timer of Array.from(this.timers)) {
      if (timer.at <= this.current) {
        this.timers.delete(timer);
        timer.wake();
      }
    }
  }
}

function requiredAdmission(result: SessionAdmission): () => void {
  if (result.kind !== "admitted") throw new Error("Expected replacement reservation");
  return result.release;
}

async function flushMicrotasks(): Promise<void> {
  for (let index: number = 0; index < 10; index += 1) await Promise.resolve();
}

function controller(
  sessions: Map<string, RetirableSession>,
  time: ManualTime,
  maximum: number = 1,
  enabled: boolean = true,
): SessionAdmissionController {
  return new SessionAdmissionController(
    sessions,
    parseHttpServerConfig({
      MURMUR_MAX_SESSIONS: String(maximum),
      MURMUR_OWNER_PRIORITY: enabled ? "1" : "0",
    }),
    time,
  );
}

test("owner replaces the least recently used established session using stable key ties", async (): Promise<void> => {
  const calls: string[] = [];
  const sessions: Map<string, RetirableSession> = new Map<string, RetirableSession>();
  for (const id of ["beta", "alpha"])
    sessions.set(id, {
      lastSeenAt: 1,
      tenantId: FOUNDING_TENANT_ID,
      transport: {
        close: async (): Promise<void> => {
          calls.push(`${id}.transport`);
        },
      },
      application: {
        close: async (): Promise<void> => {
          calls.push(`${id}.application`);
        },
      },
    });
  const admission: SessionAdmissionController = controller(sessions, new ManualTime(), 2);
  const replacement: SessionAdmission = await admission.reserveReplacingOldest(FOUNDING_TENANT_ID);
  expect(calls).toEqual(["alpha.transport", "alpha.application"]);
  expect(Array.from(sessions.keys())).toEqual(["beta"]);
  expect(admission.reserve(FOUNDING_TENANT_ID)).toEqual({ kind: "rejected", scope: "global" });
  requiredAdmission(replacement)();
  requiredAdmission(admission.reserve(FOUNDING_TENANT_ID))();
});

test("concurrent initialization cannot reuse a slot while its old transport is closing", async (): Promise<void> => {
  const closed: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  let applicationsClosed: number = 0;
  const sessions: Map<string, RetirableSession> = new Map<string, RetirableSession>([
    [
      "old",
      {
        lastSeenAt: 0,
        tenantId: FOUNDING_TENANT_ID,
        transport: { close: (): Promise<void> => closed.promise },
        application: {
          close: async (): Promise<void> => {
            applicationsClosed += 1;
          },
        },
      },
    ],
  ]);
  const admission: SessionAdmissionController = controller(sessions, new ManualTime());
  const replacement: Promise<SessionAdmission> =
    admission.reserveReplacingOldest(FOUNDING_TENANT_ID);
  expect(sessions.size).toBe(0);
  expect(await admission.reserveReplacingOldest(FOUNDING_TENANT_ID)).toEqual({
    kind: "rejected",
    scope: "global",
  });
  expect(applicationsClosed).toBe(0);
  closed.resolve();
  const result: SessionAdmission = await replacement;
  expect(applicationsClosed).toBe(1);
  const release: () => void = requiredAdmission(result);
  release();
  release();
  requiredAdmission(admission.reserve(FOUNDING_TENANT_ID))();
});

test("cleanup deadline rejects replacement but keeps its physical slot charged until settlement", async (): Promise<void> => {
  const closed: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  const time: ManualTime = new ManualTime();
  const sessions: Map<string, RetirableSession> = new Map<string, RetirableSession>([
    [
      "old",
      {
        lastSeenAt: 0,
        tenantId: FOUNDING_TENANT_ID,
        transport: { close: (): Promise<void> => closed.promise },
        application: { close: async (): Promise<void> => {} },
      },
    ],
  ]);
  const admission: SessionAdmissionController = controller(sessions, time);
  const replacement: Promise<SessionAdmission> =
    admission.reserveReplacingOldest(FOUNDING_TENANT_ID);
  time.advance(5_000);
  expect(await replacement).toEqual({ kind: "rejected", scope: "global" });
  expect(admission.reserve(FOUNDING_TENANT_ID)).toEqual({ kind: "rejected", scope: "global" });
  closed.resolve();
  await flushMicrotasks();
  requiredAdmission(admission.reserve(FOUNDING_TENANT_ID))();
});

test("failed transport cleanup still closes the application and safely rejects replacement", async (): Promise<void> => {
  const applicationClosed: ReturnType<typeof Promise.withResolvers<void>> =
    Promise.withResolvers<void>();
  let attempted: boolean = false;
  const sessions: Map<string, RetirableSession> = new Map<string, RetirableSession>([
    [
      "old",
      {
        lastSeenAt: 0,
        tenantId: FOUNDING_TENANT_ID,
        transport: {
          close: async (): Promise<void> => {
            throw new Error("Injected failure");
          },
        },
        application: {
          close: (): Promise<void> => {
            attempted = true;
            return applicationClosed.promise;
          },
        },
      },
    ],
  ]);
  const admission: SessionAdmissionController = controller(sessions, new ManualTime());
  const replacement: Promise<SessionAdmission> =
    admission.reserveReplacingOldest(FOUNDING_TENANT_ID);
  await flushMicrotasks();
  expect(attempted).toBe(true);
  expect(admission.reserve(FOUNDING_TENANT_ID)).toEqual({ kind: "rejected", scope: "global" });
  applicationClosed.resolve();
  expect(await replacement).toEqual({ kind: "rejected", scope: "global" });
  await flushMicrotasks();
  requiredAdmission(admission.reserve(FOUNDING_TENANT_ID))();
});

test("ordinary and priority-off requests never evict established sessions", async (): Promise<void> => {
  let closed: boolean = false;
  const sessions: Map<string, RetirableSession> = new Map<string, RetirableSession>([
    [
      "old",
      {
        lastSeenAt: 0,
        tenantId: FOUNDING_TENANT_ID,
        transport: {
          close: async (): Promise<void> => {
            closed = true;
          },
        },
        application: { close: async (): Promise<void> => {} },
      },
    ],
  ]);
  const enabled: SessionAdmissionController = controller(sessions, new ManualTime());
  expect(await enabled.reserveReplacingOldest("ordinary-tenant")).toEqual({
    kind: "rejected",
    scope: "global",
  });
  const disabled: SessionAdmissionController = controller(sessions, new ManualTime(), 1, false);
  expect(await disabled.reserveReplacingOldest(FOUNDING_TENANT_ID)).toEqual({
    kind: "rejected",
    scope: "global",
  });
  expect(closed).toBe(false);
  expect(sessions.size).toBe(1);
});

test("a third owner HTTP initialization replaces the oldest session and preserves the newer one", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-owner-replacement-"));
  const time: ManualTime = new ManualTime();
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_OWNER_PRIORITY: "1",
      MURMUR_MAX_SESSIONS: "2",
    },
    { timeSource: time },
  );
  try {
    const oldest: string = await initializeSession(server.mcpUrl, "oldest");
    time.advance(1);
    const newer: string = await initializeSession(server.mcpUrl, "newer");
    time.advance(1);
    const replacement: string = await initializeSession(server.mcpUrl, "replacement");
    expect(replacement).not.toBe(oldest);
    const retired: Response = await postJson(
      server.mcpUrl,
      { jsonrpc: "2.0", id: 20, method: "ping" },
      oldest,
    );
    expect(retired.status).toBe(404);
    await retired.text();
    const preserved: Response = await postJson(
      server.mcpUrl,
      { jsonrpc: "2.0", id: 21, method: "ping" },
      newer,
    );
    expect(preserved.status).toBe(200);
    await preserved.text();
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
