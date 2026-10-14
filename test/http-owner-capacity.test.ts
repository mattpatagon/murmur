import { expect, test } from "bun:test";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import { credentialAdmissionKey } from "../src/hosted/token-secret.js";
import {
  HttpCapacityController,
  type StreamCapacityReservation,
  type TimeSource,
} from "../src/http/http-capacity.js";
import { type HttpServerConfig, parseHttpServerConfig } from "../src/http/http-config.js";
import type { RemoteSession } from "../src/http/remote-session.js";
import {
  type SessionAdmission,
  SessionAdmissionController,
} from "../src/http/session-admission.js";

function ownerConfig(environment: NodeJS.ProcessEnv = {}): HttpServerConfig {
  return parseHttpServerConfig({ MURMUR_OWNER_PRIORITY: "1", ...environment });
}

function releaseRequest(reservation: (() => void) | null): () => void {
  if (reservation === null) throw new Error("Expected admitted owner capacity");
  return reservation;
}

function releaseStream(reservation: StreamCapacityReservation): () => void {
  if (reservation.kind === "rejected") throw new Error("Expected admitted owner stream");
  return reservation.release;
}

function releaseSession(reservation: SessionAdmission): () => void {
  if (reservation.kind === "rejected") throw new Error("Expected admitted owner session");
  return reservation.release;
}

test("owner priority configuration is opt-in and accepts only explicit binary values", (): void => {
  expect(parseHttpServerConfig({}).ownerPriority).toBe(false);
  expect(parseHttpServerConfig({ MURMUR_OWNER_PRIORITY: "" }).ownerPriority).toBe(false);
  expect(parseHttpServerConfig({ MURMUR_OWNER_PRIORITY: "0" }).ownerPriority).toBe(false);
  expect(ownerConfig().ownerPriority).toBe(true);
  for (const invalid of ["true", "false", "2", "01", " "]) {
    expect(
      (): HttpServerConfig => parseHttpServerConfig({ MURMUR_OWNER_PRIORITY: invalid }),
    ).toThrow();
  }
});

test("ordinary request saturation preserves owner slots and physical limits", (): void => {
  const controller: HttpCapacityController = new HttpCapacityController(
    ownerConfig({
      MURMUR_MAX_ACTIVE_REQUESTS: "8",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "1",
    }),
  );
  const ordinary: (() => void)[] = [];
  const owners: (() => void)[] = [];
  try {
    for (let index: number = 0; index < 6; index += 1) {
      ordinary.push(
        releaseRequest(controller.reserveRequest(`ordinary-${index}`, `tenant-${index}`)),
      );
    }
    expect(controller.reserveRequest("owner-spoof", "ordinary-tenant")).toBeNull();
    expect(controller.reservePublicRequest(FOUNDING_TENANT_ID)).toBeNull();
    owners.push(releaseRequest(controller.reserveRequest("owner", FOUNDING_TENANT_ID)));
    owners.push(releaseRequest(controller.reserveRequest("owner", FOUNDING_TENANT_ID)));
    expect(controller.reserveRequest("owner-extra", FOUNDING_TENANT_ID)).toBeNull();
    const releasedOwner: (() => void) | undefined = owners.pop();
    if (releasedOwner === undefined) throw new Error("Expected owner reservation");
    releasedOwner();
    releasedOwner();
    expect(controller.reserveRequest("ordinary-extra", "ordinary-extra")).toBeNull();
    owners.push(releaseRequest(controller.reserveRequest("owner", FOUNDING_TENANT_ID)));
  } finally {
    ordinary.forEach((release: () => void): void => {
      release();
    });
    owners.forEach((release: () => void): void => {
      release();
    });
  }
});

test("ordinary stream saturation preserves owner streams with idempotent cleanup", (): void => {
  const controller: HttpCapacityController = new HttpCapacityController(
    ownerConfig({
      MURMUR_MAX_ACTIVE_STREAMS: "8",
      MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "1",
      MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "1",
    }),
  );
  const reservations: (() => void)[] = [];
  try {
    for (let index: number = 0; index < 6; index += 1) {
      reservations.push(
        releaseStream(controller.reserveStream(`ordinary-${index}`, `tenant-${index}`)),
      );
    }
    expect(controller.reserveStream("owner-spoof", "ordinary-tenant")).toEqual({
      kind: "rejected",
      scope: "global",
    });
    const owner: () => void = releaseStream(controller.reserveStream("owner", FOUNDING_TENANT_ID));
    reservations.push(owner);
    reservations.push(releaseStream(controller.reserveStream("owner", FOUNDING_TENANT_ID)));
    expect(controller.reserveStream("owner-extra", FOUNDING_TENANT_ID)).toEqual({
      kind: "rejected",
      scope: "global",
    });
    owner();
    owner();
    reservations.push(releaseStream(controller.reserveStream("owner", FOUNDING_TENANT_ID)));
  } finally {
    reservations.forEach((release: () => void): void => {
      release();
    });
  }
});

test("pending session construction reserves owner slots before yielding", (): void => {
  const sessions: Map<string, RemoteSession> = new Map<string, RemoteSession>();
  const controller: SessionAdmissionController = new SessionAdmissionController(
    sessions,
    ownerConfig({
      MURMUR_MAX_SESSIONS: "8",
      MURMUR_MAX_SESSIONS_PER_TENANT: "1",
    }),
  );
  const reservations: (() => void)[] = [];
  try {
    for (let index: number = 0; index < 6; index += 1) {
      reservations.push(releaseSession(controller.reserve(`tenant-${index}`)));
    }
    expect(controller.reserve(null)).toEqual({ kind: "rejected", scope: "global" });
    const owner: () => void = releaseSession(controller.reserve(FOUNDING_TENANT_ID));
    reservations.push(owner);
    reservations.push(releaseSession(controller.reserve(FOUNDING_TENANT_ID)));
    expect(controller.reserve(FOUNDING_TENANT_ID)).toEqual({ kind: "rejected", scope: "global" });
    owner();
    owner();
    reservations.push(releaseSession(controller.reserve(FOUNDING_TENANT_ID)));
  } finally {
    reservations.forEach((release: () => void): void => {
      release();
    });
  }
});

test("known owner authentication remains serialized and cannot be claimed by an unknown credential", async (): Promise<void> => {
  const controller: HttpCapacityController = new HttpCapacityController(
    ownerConfig({ MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4" }),
  );
  const tenantKey: string = credentialAdmissionKey(FOUNDING_TENANT_ID);
  const reservations: (() => void)[] = [];
  try {
    for (let index: number = 0; index < 3; index += 1) {
      reservations.push(
        releaseRequest(
          await controller.reserveAuthentication(`ordinary-${index}`, `tenant-${index}`, true),
        ),
      );
    }
    expect(await controller.reserveAuthentication("spoof", tenantKey, false)).toBeNull();
    const owner: () => void = releaseRequest(
      await controller.reserveAuthentication("owner", tenantKey, true),
    );
    reservations.push(owner);
    const serialized: Promise<(() => void) | null> = controller.reserveAuthentication(
      "owner",
      tenantKey,
      true,
    );
    owner();
    owner();
    const nextOwner: () => void = releaseRequest(await serialized);
    reservations.push(nextOwner);
    const saturated: Promise<(() => void) | null> = controller.reserveAuthentication(
      "owner-extra",
      tenantKey,
      true,
    );
    controller.stop();
    expect(await saturated).toBeNull();
    expect(await controller.reserveAuthentication("owner-after-stop", tenantKey, true)).toBeNull();
  } finally {
    controller.stop();
    reservations.forEach((release: () => void): void => {
      release();
    });
  }
});

test("ordinary authentication waiters leave owner queue headroom and stop cancels every waiter", async (): Promise<void> => {
  const controller: HttpCapacityController = new HttpCapacityController(
    ownerConfig({
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4",
      MURMUR_MAX_PENDING_AUTHENTICATIONS: "4",
      MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT: "1",
    }),
  );
  const tenantKey: string = credentialAdmissionKey(FOUNDING_TENANT_ID);
  const reservations: (() => void)[] = [];
  const pending: Promise<(() => void) | null>[] = [];
  try {
    for (let index: number = 0; index < 3; index += 1) {
      reservations.push(
        releaseRequest(
          await controller.reserveAuthentication(`active-${index}`, `active-tenant-${index}`, true),
        ),
      );
    }
    reservations.push(
      releaseRequest(await controller.reserveAuthentication("owner", tenantKey, true)),
    );
    for (let index: number = 0; index < 3; index += 1) {
      pending.push(
        controller.reserveAuthentication(`waiting-${index}`, `waiting-tenant-${index}`, true),
      );
    }
    expect(
      await controller.reserveAuthentication("ordinary-overflow", "ordinary-overflow", true),
    ).toBeNull();
    pending.push(controller.reserveAuthentication("owner", tenantKey, true));
    expect(await controller.reserveAuthentication("owner-overflow", tenantKey, true)).toBeNull();
    controller.stop();
    expect(await Promise.all(pending)).toEqual([null, null, null, null]);
  } finally {
    controller.stop();
    reservations.forEach((release: () => void): void => {
      release();
    });
  }
});

test("a single physical slot remains bounded and priority-off preserves ordinary capacity", (): void => {
  const enabled: HttpCapacityController = new HttpCapacityController(
    ownerConfig({ MURMUR_MAX_ACTIVE_REQUESTS: "1" }),
  );
  expect(enabled.reserveRequest("ordinary", "ordinary")).toBeNull();
  const owner: () => void = releaseRequest(enabled.reserveRequest("owner", FOUNDING_TENANT_ID));
  expect(enabled.reserveRequest("owner-extra", FOUNDING_TENANT_ID)).toBeNull();
  owner();
  const disabled: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({ MURMUR_MAX_ACTIVE_REQUESTS: "1" }),
  );
  const ordinary: () => void = releaseRequest(disabled.reserveRequest("ordinary", "ordinary"));
  expect(disabled.reserveRequest("owner", FOUNDING_TENANT_ID)).toBeNull();
  ordinary();
});

test("owner request, stream and session scope ceilings equal their physical budgets", (): void => {
  const config: HttpServerConfig = ownerConfig({
    MURMUR_MAX_ACTIVE_REQUESTS: "8",
    MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1",
    MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "1",
    MURMUR_MAX_ACTIVE_STREAMS: "8",
    MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "1",
    MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "1",
    MURMUR_MAX_SESSIONS: "8",
    MURMUR_MAX_SESSIONS_PER_TENANT: "1",
  });
  const requests: HttpCapacityController = new HttpCapacityController(config);
  const sessions: SessionAdmissionController = new SessionAdmissionController(
    new Map<string, RemoteSession>(),
    config,
  );
  const reservations: (() => void)[] = [];
  try {
    for (let index: number = 0; index < 8; index += 1) {
      reservations.push(releaseRequest(requests.reserveRequest("owner", FOUNDING_TENANT_ID)));
      reservations.push(releaseStream(requests.reserveStream("owner", FOUNDING_TENANT_ID)));
      reservations.push(releaseSession(sessions.reserve(FOUNDING_TENANT_ID)));
    }
    expect(requests.reserveRequest("owner", FOUNDING_TENANT_ID)).toBeNull();
    expect(requests.reserveStream("owner", FOUNDING_TENANT_ID)).toEqual({
      kind: "rejected",
      scope: "principal",
    });
    expect(sessions.reserve(FOUNDING_TENANT_ID)).toEqual({ kind: "rejected", scope: "global" });
  } finally {
    reservations.forEach((release: () => void): void => {
      release();
    });
  }
});

test("owner tenant authentication can use the physical budget while each credential stays serialized", async (): Promise<void> => {
  const controller: HttpCapacityController = new HttpCapacityController(
    ownerConfig({ MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4" }),
  );
  const tenantKey: string = credentialAdmissionKey(FOUNDING_TENANT_ID);
  const reservations: (() => void)[] = [];
  try {
    for (let index: number = 0; index < 4; index += 1) {
      reservations.push(
        releaseRequest(await controller.reserveAuthentication(`owner-${index}`, tenantKey, true)),
      );
    }
    const exhausted: Promise<(() => void) | null> = controller.reserveAuthentication(
      "owner-extra",
      tenantKey,
      true,
    );
    controller.stop();
    expect(await exhausted).toBeNull();
  } finally {
    controller.stop();
    reservations.forEach((release: () => void): void => {
      release();
    });
  }
});

test("ordinary rate-window saturation reserves owner bookkeeping and expiry releases bounded space", (): void => {
  let now: number = 0;
  const time: TimeSource = {
    now: (): number => now,
    schedule:
      (_milliseconds: number, _wake: () => void): (() => void) =>
      (): void => {},
  };
  const controller: HttpCapacityController = new HttpCapacityController(ownerConfig(), time);
  let ordinaryAccepted: number = 0;
  for (let index: number = 0; index < 49_152; index += 1) {
    if (controller.rateLimitAllows(`ordinary-${index}`, 2)) ordinaryAccepted += 1;
  }
  expect(ordinaryAccepted).toBe(49_152);
  expect(controller.rateLimitAllows("overflow", 2)).toBe(false);
  expect(controller.rateLimitAllows(FOUNDING_TENANT_ID, 2, "ordinary")).toBe(false);
  expect(controller.rateLimitAllows("ordinary-0", 2)).toBe(true);
  expect(controller.rateLimitAllows("ordinary-0", 2)).toBe(false);
  let ownerAccepted: number = 0;
  for (let index: number = 0; index < 16_384; index += 1) {
    if (controller.rateLimitAllows(`owner-${index}`, 2, FOUNDING_TENANT_ID)) ownerAccepted += 1;
  }
  expect(ownerAccepted).toBe(16_384);
  expect(controller.rateLimitAllows("owner-overflow", 2, FOUNDING_TENANT_ID)).toBe(false);
  now = 60_000;
  expect(controller.rateLimitAllows("owner-0", 2, FOUNDING_TENANT_ID)).toBe(true);
  expect(controller.rateLimitAllows("owner-overflow", 2, FOUNDING_TENANT_ID)).toBe(false);
  now = 120_000;
  controller.pruneRateWindows();
  expect(controller.rateLimitAllows("ordinary-recovered", 2)).toBe(true);
  expect(controller.rateLimitAllows("owner-overflow", 2, FOUNDING_TENANT_ID)).toBe(true);
  now = 240_000;
  controller.pruneRateWindows();
  expect(controller.rateLimitAllows("ordinary-0", 2)).toBe(true);
  expect(controller.rateLimitAllows("ordinary-0", 2)).toBe(true);
  expect(controller.rateLimitAllows("ordinary-0", 2)).toBe(false);
});

test("priority-off rate bookkeeping retains the full ordinary physical capacity", (): void => {
  const time: TimeSource = {
    now: (): number => 0,
    schedule:
      (_milliseconds: number, _wake: () => void): (() => void) =>
      (): void => {},
  };
  const controller: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({}),
    time,
  );
  let accepted: number = 0;
  for (let index: number = 0; index < 65_536; index += 1) {
    if (controller.rateLimitAllows(`ordinary-${index}`, 1)) accepted += 1;
  }
  expect(accepted).toBe(65_536);
  expect(controller.rateLimitAllows("overflow", 1, FOUNDING_TENANT_ID)).toBe(false);
});
