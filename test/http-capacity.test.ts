import { describe, expect, test } from "bun:test";

import { HttpCapacityController, type TimeSource } from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";

type Sleeper = {
  readonly deadline: number;
  readonly resolve: () => void;
};

class FakeTimeSource implements TimeSource {
  private current: number;
  private sleepers: Sleeper[];

  public constructor(current: number = 0) {
    this.current = current;
    this.sleepers = [];
  }

  public now(): number {
    return this.current;
  }

  public schedule(milliseconds: number, wake: () => void): () => void {
    const sleeper: Sleeper = { deadline: this.current + milliseconds, resolve: wake };
    this.sleepers.push(sleeper);
    return (): void => {
      this.sleepers = this.sleepers.filter((candidate: Sleeper): boolean => candidate !== sleeper);
    };
  }

  public pendingSleeps(): number {
    return this.sleepers.length;
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
    const ready: Sleeper[] = this.sleepers.filter(
      (sleeper: Sleeper): boolean => sleeper.deadline <= this.current,
    );
    this.sleepers = this.sleepers.filter(
      (sleeper: Sleeper): boolean => sleeper.deadline > this.current,
    );
    ready.forEach((sleeper: Sleeper): void => {
      sleeper.resolve();
    });
  }
}

function capacity(time: TimeSource, environment: NodeJS.ProcessEnv = {}): HttpCapacityController {
  return new HttpCapacityController(parseHttpServerConfig(environment), time);
}

function requiredRelease(reservation: (() => void) | null): () => void {
  if (reservation === null) throw new Error("Expected capacity reservation");
  return reservation;
}

describe("HTTP capacity controller", (): void => {
  test("rate windows roll over deterministically", (): void => {
    const time: FakeTimeSource = new FakeTimeSource();
    const controller: HttpCapacityController = capacity(time, {
      MURMUR_RATE_LIMIT_PER_MINUTE: "2",
    });

    expect(controller.rateLimitAllows("principal-a")).toBe(true);
    expect(controller.rateLimitAllows("principal-a")).toBe(true);
    expect(controller.rateLimitAllows("principal-a")).toBe(false);
    expect(controller.rateLimitAllows("principal-b")).toBe(true);

    time.advance(60_000);
    expect(controller.rateLimitAllows("principal-a")).toBe(true);
    time.advance(120_000);
    controller.pruneRateWindows();
    expect(controller.rateLimitAllows("principal-b")).toBe(true);
  });

  test("request reservations enforce global, principal, and tenant limits", (): void => {
    const controller: HttpCapacityController = capacity(new FakeTimeSource(), {
      MURMUR_MAX_ACTIVE_REQUESTS: "2",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "1",
    });
    const releaseA: () => void = requiredRelease(controller.reserveRequest("principal-a", "a"));

    expect(controller.reserveRequest("principal-a", "b")).toBeNull();
    expect(controller.reserveRequest("principal-b", "a")).toBeNull();
    const releaseB: () => void = requiredRelease(controller.reserveRequest("principal-b", "b"));
    expect(controller.reserveRequest("principal-c", "c")).toBeNull();

    releaseA();
    releaseA();
    const releaseC: () => void = requiredRelease(controller.reserveRequest("principal-c", "a"));
    releaseB();
    releaseC();
  });

  test("public request reservations leave one global slot for authenticated work", (): void => {
    const controller: HttpCapacityController = capacity(new FakeTimeSource(), {
      MURMUR_MAX_ACTIVE_REQUESTS: "2",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "2",
    });
    const releasePublic: () => void = requiredRelease(
      controller.reservePublicRequest("oauth-public"),
    );
    expect(controller.reservePublicRequest("oauth-public")).toBeNull();
    const releaseAuthenticated: () => void = requiredRelease(
      controller.reserveRequest("authenticated", "tenant-a"),
    );
    expect(controller.reserveRequest("another", "tenant-b")).toBeNull();
    releasePublic();
    releaseAuthenticated();

    const singleSlot: HttpCapacityController = capacity(new FakeTimeSource(), {
      MURMUR_MAX_ACTIVE_REQUESTS: "1",
    });
    expect(singleSlot.reservePublicRequest("oauth-public")).toBeNull();
    requiredRelease(singleSlot.reserveRequest("authenticated", "tenant-a"))();
  });

  test("stream reservations enforce global, principal, and tenant limits independently", (): void => {
    const controller: HttpCapacityController = capacity(new FakeTimeSource(), {
      MURMUR_MAX_ACTIVE_STREAMS: "3",
      MURMUR_MAX_ACTIVE_STREAMS_PER_PRINCIPAL: "1",
      MURMUR_MAX_ACTIVE_STREAMS_PER_TENANT: "2",
    });
    const releaseA: () => void = requiredRelease(controller.reserveStream("principal-a", "a"));

    expect(controller.reserveStream("principal-a", "b")).toBeNull();
    const releaseB: () => void = requiredRelease(controller.reserveStream("principal-b", "a"));
    expect(controller.reserveStream("principal-c", "a")).toBeNull();
    const releaseC: () => void = requiredRelease(controller.reserveStream("principal-c", null));
    expect(controller.reserveStream("principal-d", "b")).toBeNull();

    releaseA();
    releaseA();
    const releaseD: () => void = requiredRelease(controller.reserveStream("principal-d", "b"));
    releaseB();
    releaseC();
    releaseD();
  });

  test("known credentials wait and wake when authentication capacity is released", async (): Promise<void> => {
    const time: FakeTimeSource = new FakeTimeSource();
    const controller: HttpCapacityController = capacity(time, {
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
    });
    const releaseFirst: () => void = requiredRelease(
      await controller.reserveAuthentication("credential-a", "tenant-a", true),
    );
    const waiting: Promise<(() => void) | null> = controller.reserveAuthentication(
      "credential-b",
      "tenant-b",
      true,
    );

    releaseFirst();
    const releaseSecond: () => void = requiredRelease(await waiting);
    expect(time.pendingSleeps()).toBe(0);
    releaseSecond();
  });

  test("unknown credentials never occupy the pending queue", async (): Promise<void> => {
    const controller: HttpCapacityController = capacity(new FakeTimeSource(), {
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "2",
    });
    const releaseKnown: () => void = requiredRelease(
      await controller.reserveAuthentication("credential-a", "tenant-a", true),
    );

    expect(await controller.reserveAuthentication("forged", null, false)).toBeNull();
    releaseKnown();
  });

  test("pending limits and shutdown reject queued authentications", async (): Promise<void> => {
    const controller: HttpCapacityController = capacity(new FakeTimeSource(), {
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT: "1",
    });
    const releaseActive: () => void = requiredRelease(
      await controller.reserveAuthentication("credential-a", "tenant-a", true),
    );
    const waiting: Promise<(() => void) | null> = controller.reserveAuthentication(
      "credential-b",
      "tenant-b",
      true,
    );

    expect(await controller.reserveAuthentication("credential-c", "tenant-b", true)).toBeNull();
    controller.stop();
    expect(await waiting).toBeNull();
    expect(await controller.reserveAuthentication("credential-d", "tenant-d", true)).toBeNull();
    releaseActive();
  });

  test("queued authentication times out against the injected clock", async (): Promise<void> => {
    const time: FakeTimeSource = new FakeTimeSource();
    const controller: HttpCapacityController = capacity(time, {
      MURMUR_AUTHENTICATION_WAIT_MS: "10",
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
    });
    const releaseActive: () => void = requiredRelease(
      await controller.reserveAuthentication("credential-a", "tenant-a", true),
    );
    const waiting: Promise<(() => void) | null> = controller.reserveAuthentication(
      "credential-b",
      "tenant-b",
      true,
    );

    time.advance(10);
    expect(await waiting).toBeNull();
    releaseActive();
  });
});
