import { expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  HttpCapacityController,
  type StreamCapacityReservation,
  type TimeSource,
} from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";
import { OwnerStreamAdmissionController } from "../src/http/owner-stream-admission.js";
import type { RemoteSession } from "../src/http/remote-session.js";
import { trackSessionResponse } from "../src/http/remote-stream-lifecycle.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { createHttpObservability } from "../src/observability/request-observation.js";
import { StructuredLogger } from "../src/observability/structured-logger.js";
import { createTelemetry } from "../src/observability/telemetry.js";

class Time implements TimeSource {
  public current: number = 0;
  public readonly pending: Set<() => void> = new Set<() => void>();
  public now(): number {
    return this.current;
  }
  public schedule(_milliseconds: number, wake: () => void): () => void {
    this.pending.add(wake);
    return (): void => {
      this.pending.delete(wake);
    };
  }
  public expire(): void {
    this.current += 1000;
    for (const wake of Array.from(this.pending)) wake();
  }
}

class Transport extends WebStandardStreamableHTTPServerTransport {
  public closes: number = 0;
  public override closeStandaloneSSEStream(): void {
    this.closes += 1;
  }
}

function session(): RemoteSession & { readonly transport: Transport } {
  return {
    activeResponses: 0,
    application: new MurmurApplication({
      branchName: null,
      client: null,
      repositoryName: null,
      store: null,
    }),
    lastSeenAt: 0,
    principalIdentity: "owner",
    tenantId: FOUNDING_TENANT_ID,
    tokenId: "owner",
    transport: new Transport(),
  };
}

function release(reservation: StreamCapacityReservation): () => void {
  if (reservation.kind !== "reserved") throw new Error("Expected stream reservation");
  return reservation.release;
}

function fixture(): {
  readonly admissions: OwnerStreamAdmissionController;
  readonly capacity: HttpCapacityController;
  readonly sessions: Map<string, RemoteSession & { readonly transport: Transport }>;
  readonly time: Time;
} {
  const config: ReturnType<typeof parseHttpServerConfig> = parseHttpServerConfig({
    MURMUR_OWNER_PRIORITY: "1",
    MURMUR_MAX_ACTIVE_STREAMS: "2",
  });
  const time: Time = new Time();
  const capacity: HttpCapacityController = new HttpCapacityController(config, time);
  const sessions: Map<string, RemoteSession & { readonly transport: Transport }> = new Map([
    ["old", session()],
    ["next", session()],
    ["new", session()],
  ]);
  return {
    admissions: new OwnerStreamAdmissionController(capacity, sessions, config, time),
    capacity,
    sessions,
    time,
  };
}

async function cleanup(testFixture: ReturnType<typeof fixture>): Promise<void> {
  testFixture.admissions.stop();
  for (const item of testFixture.sessions.values()) await item.application.close();
}

function requiredSession(
  testFixture: ReturnType<typeof fixture>,
  id: string,
): RemoteSession & { readonly transport: Transport } {
  const result: (RemoteSession & { readonly transport: Transport }) | undefined =
    testFixture.sessions.get(id);
  if (result === undefined) throw new Error("Missing session");
  return result;
}

test("owner retires oldest stream but waits for actual capacity release and retains every session", async (): Promise<void> => {
  const state: ReturnType<typeof fixture> = fixture();
  const old: RemoteSession & { readonly transport: Transport } = requiredSession(state, "old");
  const next: RemoteSession & { readonly transport: Transport } = requiredSession(state, "next");
  const releases: (() => void)[] = [];
  try {
    releases.push(release(await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "old")));
    releases.push(release(await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "next")));
    old.standaloneStream = { openedAt: 1 };
    next.standaloneStream = { openedAt: 2 };
    const pending: Promise<StreamCapacityReservation> = state.admissions.reserve(
      "owner",
      FOUNDING_TENANT_ID,
      "new",
    );
    expect(old.transport.closes).toBe(1);
    expect(next.transport.closes).toBe(0);
    expect(state.capacity.reserveStream("owner", FOUNDING_TENANT_ID).kind).toBe("rejected");
    let settled: boolean = false;
    void pending.then((): void => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const finishOld: (() => void) | undefined = releases[0];
    if (finishOld === undefined) throw new Error("Missing old reservation");
    finishOld();
    releases.push(release(await pending));
    expect(state.sessions.size).toBe(3);
    expect(state.capacity.reserveStream("owner", FOUNDING_TENANT_ID).kind).toBe("rejected");
    expect(state.time.pending.size).toBe(0);
  } finally {
    for (const finish of releases) finish();
    await cleanup(state);
  }
});

test("ordinary, invalid-session and duplicate-stream requests cannot retire a stream", async (): Promise<void> => {
  const state: ReturnType<typeof fixture> = fixture();
  const old: RemoteSession & { readonly transport: Transport } = requiredSession(state, "old");
  const finishOld: () => void = release(
    await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "old"),
  );
  const finishNext: () => void = release(
    await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "next"),
  );
  old.standaloneStream = { openedAt: 1 };
  try {
    for (const [principal, tenant, id] of [
      ["ordinary", "ordinary", "new"],
      ["owner", FOUNDING_TENANT_ID, "missing"],
      ["wrong", FOUNDING_TENANT_ID, "new"],
      ["owner", FOUNDING_TENANT_ID, "old"],
    ]) {
      if (principal === undefined || tenant === undefined || id === undefined)
        throw new Error("Missing case");
      expect((await state.admissions.reserve(principal, tenant, id)).kind).toBe("rejected");
    }
    expect(old.transport.closes).toBe(0);
    expect(state.time.pending.size).toBe(0);
  } finally {
    finishOld();
    finishNext();
    await cleanup(state);
  }
});

test("retirement waiting has a bounded queue, absolute timeout and shutdown cancellation", async (): Promise<void> => {
  const state: ReturnType<typeof fixture> = fixture();
  const finishOld: () => void = release(
    await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "old"),
  );
  const finishNext: () => void = release(
    await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "next"),
  );
  requiredSession(state, "old").standaloneStream = { openedAt: 1 };
  try {
    const pending: Promise<StreamCapacityReservation>[] = [];
    for (let index: number = 0; index < 64; index += 1)
      pending.push(state.admissions.reserve("owner", FOUNDING_TENANT_ID, "new"));
    expect(state.time.pending.size).toBe(64);
    expect((await state.admissions.reserve("owner", FOUNDING_TENANT_ID, "new")).kind).toBe(
      "rejected",
    );
    expect(requiredSession(state, "old").transport.closes).toBe(1);
    state.time.expire();
    expect(
      (await Promise.all(pending)).every(
        (result: StreamCapacityReservation): boolean => result.kind === "rejected",
      ),
    ).toBe(true);
    expect(state.time.pending.size).toBe(0);
    const abort: AbortController = new AbortController();
    const cancelled: Promise<StreamCapacityReservation> = state.admissions.reserve(
      "owner",
      FOUNDING_TENANT_ID,
      "new",
      abort.signal,
    );
    abort.abort();
    expect((await cancelled).kind).toBe("rejected");
    expect(state.time.pending.size).toBe(0);
    const stopping: Promise<StreamCapacityReservation> = state.admissions.reserve(
      "owner",
      FOUNDING_TENANT_ID,
      "new",
    );
    state.admissions.stop();
    expect((await stopping).kind).toBe("rejected");
    expect(state.time.pending.size).toBe(0);
  } finally {
    finishOld();
    finishNext();
    await cleanup(state);
  }
});

test("only actual successful standalone SSE responses are tracked and old completion cannot clear a replacement", async (): Promise<void> => {
  const item: RemoteSession = session();
  const time: Time = new Time();
  const environment: NodeJS.ProcessEnv = { MURMUR_LOG_LEVEL: "off" };
  const observation: ReturnType<ReturnType<typeof createHttpObservability>["observe"]> =
    createHttpObservability(
      new StructuredLogger(environment),
      createTelemetry(environment),
    ).observe(new Request("http://localhost/mcp"));
  try {
    const rejected: Response = trackSessionResponse(
      new Response("conflict", { status: 409 }),
      item,
      "session",
      true,
      50_000,
      time,
      observation,
    );
    expect(item.standaloneStream).toBeUndefined();
    await rejected.text();
    const first: Response = trackSessionResponse(
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      }),
      item,
      "session",
      true,
      50_000,
      time,
      observation,
    );
    expect(item.standaloneStream).toEqual({ openedAt: 0 });
    time.current = 2;
    const replacement: Response = trackSessionResponse(
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      }),
      item,
      "session",
      true,
      50_000,
      time,
      observation,
    );
    if (first.body === null || replacement.body === null) throw new Error("Missing stream body");
    await first.body.cancel();
    expect(item.standaloneStream).toEqual({ openedAt: 2 });
    await replacement.body.cancel();
    expect(item.standaloneStream).toBeUndefined();
    expect(item.activeResponses).toBe(0);
    expect(time.pending.size).toBe(0);
  } finally {
    await item.application.close();
  }
});
