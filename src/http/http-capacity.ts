import type { HttpServerConfig } from "./http-config.js";
import {
  admittedGlobalLimit,
  admittedScopeLimit,
  isOwnerAuthentication,
  isOwnerTenant,
} from "./owner-capacity-policy.js";

const MAX_RATE_WINDOWS: number = 65_536;

export type StreamCapacityScope = "global" | "principal" | "tenant";
export type StreamCapacityReservation =
  | { readonly kind: "reserved"; readonly release: () => void }
  | { readonly kind: "rejected"; readonly scope: StreamCapacityScope };

export type TimeSource = {
  now(): number;
  schedule(milliseconds: number, wake: () => void): () => void;
};

export const SYSTEM_TIME_SOURCE: TimeSource = {
  now: (): number => Date.now(),
  schedule: (milliseconds: number, wake: () => void): (() => void) => {
    const timeout: ReturnType<typeof setTimeout> = setTimeout(wake, milliseconds);
    timeout.unref();
    return (): void => clearTimeout(timeout);
  },
};

export class HttpCapacityController {
  private readonly activeAuthenticationsByCredential: Map<string, number>;
  private readonly activeAuthenticationsByTenant: Map<string, number>;
  private readonly activeRequestsByPrincipal: Map<string, number>;
  private readonly activeRequestsByTenant: Map<string, number>;
  private readonly activeStreamsByPrincipal: Map<string, number>;
  private readonly activeStreamsByTenant: Map<string, number>;
  private readonly authenticationWaiters: Set<() => void>;
  private readonly config: HttpServerConfig;
  private readonly pendingAuthenticationsByTenant: Map<string, number>;
  private readonly rateWindows: Map<string, { count: number; startedAt: number }>;
  private readonly time: TimeSource;
  private activeAuthentications: number;
  private activeRequests: number;
  private activeStreams: number;
  private pendingAuthentications: number;
  private stopped: boolean;

  public constructor(config: HttpServerConfig, time: TimeSource = SYSTEM_TIME_SOURCE) {
    this.activeAuthentications = 0;
    this.activeAuthenticationsByCredential = new Map<string, number>();
    this.activeAuthenticationsByTenant = new Map<string, number>();
    this.activeRequests = 0;
    this.activeRequestsByPrincipal = new Map<string, number>();
    this.activeRequestsByTenant = new Map<string, number>();
    this.activeStreams = 0;
    this.activeStreamsByPrincipal = new Map<string, number>();
    this.activeStreamsByTenant = new Map<string, number>();
    this.authenticationWaiters = new Set<() => void>();
    this.config = config;
    this.pendingAuthentications = 0;
    this.pendingAuthenticationsByTenant = new Map<string, number>();
    this.rateWindows = new Map<string, { count: number; startedAt: number }>();
    this.stopped = false;
    this.time = time;
  }

  public now(): number {
    return this.time.now();
  }

  public rateLimitAllows(
    identity: string,
    limit: number = this.config.rateLimitPerMinute,
    tenantId: string | null = null,
  ): boolean {
    this.pruneRateWindows();
    const now: number = this.time.now();
    const existing: { count: number; startedAt: number } | undefined =
      this.rateWindows.get(identity);
    if (existing === undefined || now - existing.startedAt >= 60_000) {
      const owner: boolean = isOwnerTenant(this.config.ownerPriority, tenantId);
      if (
        existing === undefined &&
        this.rateWindows.size >=
          admittedGlobalLimit(MAX_RATE_WINDOWS, this.config.ownerPriority, owner)
      )
        return false;
      // Reinsert renewed windows so expiry cleanup can stop at the first live entry.
      this.rateWindows.delete(identity);
      this.rateWindows.set(identity, { count: 1, startedAt: now });
      return true;
    }
    if (existing.count >= limit) return false;
    existing.count += 1;
    return true;
  }

  public pruneRateWindows(): void {
    const now: number = this.time.now();
    for (const [identity, window] of this.rateWindows) {
      if (now - window.startedAt < 120_000) break;
      this.rateWindows.delete(identity);
    }
  }

  public reserveRequest(principalIdentity: string, tenantId: string | null): (() => void) | null {
    const owner: boolean = isOwnerTenant(this.config.ownerPriority, tenantId);
    const principalRequests: number = this.activeRequestsByPrincipal.get(principalIdentity) ?? 0;
    const tenantRequests: number =
      tenantId === null ? 0 : (this.activeRequestsByTenant.get(tenantId) ?? 0);
    if (
      this.activeRequests >=
        admittedGlobalLimit(this.config.maxActiveRequests, this.config.ownerPriority, owner) ||
      principalRequests >=
        admittedScopeLimit(
          this.config.maxActiveRequests,
          this.config.maxActiveRequestsPerPrincipal,
          owner,
        ) ||
      (tenantId !== null &&
        tenantRequests >=
          admittedScopeLimit(
            this.config.maxActiveRequests,
            this.config.maxActiveRequestsPerTenant,
            owner,
          ))
    ) {
      return null;
    }
    this.activeRequests += 1;
    this.activeRequestsByPrincipal.set(principalIdentity, principalRequests + 1);
    if (tenantId !== null) this.activeRequestsByTenant.set(tenantId, tenantRequests + 1);
    let released: boolean = false;
    return (): void => {
      if (released) return;
      released = true;
      this.activeRequests -= 1;
      const remainingForPrincipal: number =
        (this.activeRequestsByPrincipal.get(principalIdentity) ?? 1) - 1;
      if (remainingForPrincipal === 0) this.activeRequestsByPrincipal.delete(principalIdentity);
      else this.activeRequestsByPrincipal.set(principalIdentity, remainingForPrincipal);
      if (tenantId !== null) {
        const remainingForTenant: number = (this.activeRequestsByTenant.get(tenantId) ?? 1) - 1;
        if (remainingForTenant === 0) this.activeRequestsByTenant.delete(tenantId);
        else this.activeRequestsByTenant.set(tenantId, remainingForTenant);
      }
    };
  }

  public reservePublicRequest(identity: string): (() => void) | null {
    if (this.activeRequests >= this.config.maxActiveRequests - 1) return null;
    return this.reserveRequest(identity, null);
  }

  public reserveStream(
    principalIdentity: string,
    tenantId: string | null,
  ): StreamCapacityReservation {
    const owner: boolean = isOwnerTenant(this.config.ownerPriority, tenantId);
    const principalStreams: number = this.activeStreamsByPrincipal.get(principalIdentity) ?? 0;
    const tenantStreams: number =
      tenantId === null ? 0 : (this.activeStreamsByTenant.get(tenantId) ?? 0);
    // A caller already over its own quota remains throttled even when the process is full.
    if (
      principalStreams >=
      admittedScopeLimit(
        this.config.maxActiveStreams,
        this.config.maxActiveStreamsPerPrincipal,
        owner,
      )
    ) {
      return { kind: "rejected", scope: "principal" };
    }
    if (
      tenantId !== null &&
      tenantStreams >=
        admittedScopeLimit(
          this.config.maxActiveStreams,
          this.config.maxActiveStreamsPerTenant,
          owner,
        )
    ) {
      return { kind: "rejected", scope: "tenant" };
    }
    if (
      this.activeStreams >=
      admittedGlobalLimit(this.config.maxActiveStreams, this.config.ownerPriority, owner)
    ) {
      return { kind: "rejected", scope: "global" };
    }
    this.activeStreams += 1;
    this.activeStreamsByPrincipal.set(principalIdentity, principalStreams + 1);
    if (tenantId !== null) this.activeStreamsByTenant.set(tenantId, tenantStreams + 1);
    let released: boolean = false;
    const release: () => void = (): void => {
      if (released) return;
      released = true;
      this.activeStreams -= 1;
      const remainingForPrincipal: number =
        (this.activeStreamsByPrincipal.get(principalIdentity) ?? 1) - 1;
      if (remainingForPrincipal === 0) this.activeStreamsByPrincipal.delete(principalIdentity);
      else this.activeStreamsByPrincipal.set(principalIdentity, remainingForPrincipal);
      if (tenantId !== null) {
        const remainingForTenant: number = (this.activeStreamsByTenant.get(tenantId) ?? 1) - 1;
        if (remainingForTenant === 0) this.activeStreamsByTenant.delete(tenantId);
        else this.activeStreamsByTenant.set(tenantId, remainingForTenant);
      }
    };
    return { kind: "reserved", release };
  }

  private notifyAuthenticationCapacityChanged(): void {
    const waiters: readonly (() => void)[] = Array.from(this.authenticationWaiters);
    this.authenticationWaiters.clear();
    waiters.forEach((wake: () => void): void => {
      wake();
    });
  }

  private tryReserveAuthentication(
    admissionKey: string,
    admittedTenantKey: string | null,
    knownCredential: boolean,
  ): (() => void) | null {
    const owner: boolean = isOwnerAuthentication(
      this.config.ownerPriority,
      admittedTenantKey,
      knownCredential,
    );
    const activeForCredential: number =
      this.activeAuthenticationsByCredential.get(admissionKey) ?? 0;
    const activeForTenant: number =
      admittedTenantKey === null
        ? 0
        : (this.activeAuthenticationsByTenant.get(admittedTenantKey) ?? 0);
    const unknownLimit: number = Math.max(1, this.config.maxAuthentications - 1);
    if (
      this.activeAuthentications >=
        admittedGlobalLimit(this.config.maxAuthentications, this.config.ownerPriority, owner) ||
      activeForCredential >= 1 ||
      activeForTenant >= admittedScopeLimit(this.config.maxAuthentications, 2, owner) ||
      (!knownCredential && this.activeAuthentications >= unknownLimit)
    ) {
      return null;
    }
    this.activeAuthentications += 1;
    this.activeAuthenticationsByCredential.set(admissionKey, activeForCredential + 1);
    if (admittedTenantKey !== null) {
      this.activeAuthenticationsByTenant.set(admittedTenantKey, activeForTenant + 1);
    }
    let released: boolean = false;
    return (): void => {
      if (released) return;
      released = true;
      this.activeAuthentications -= 1;
      this.activeAuthenticationsByCredential.delete(admissionKey);
      if (admittedTenantKey !== null) {
        const remaining: number =
          (this.activeAuthenticationsByTenant.get(admittedTenantKey) ?? 1) - 1;
        if (remaining === 0) this.activeAuthenticationsByTenant.delete(admittedTenantKey);
        else this.activeAuthenticationsByTenant.set(admittedTenantKey, remaining);
      }
      this.notifyAuthenticationCapacityChanged();
    };
  }

  private async waitForAuthenticationCapacity(timeoutMs: number): Promise<void> {
    let wake: (() => void) | null = null;
    let cancelTimeout: () => void = (): void => {};
    const capacityChanged: Promise<void> = new Promise((resolve: () => void): void => {
      wake = resolve;
      this.authenticationWaiters.add(resolve);
    });
    const elapsed: Promise<void> = new Promise((resolve: () => void): void => {
      cancelTimeout = this.time.schedule(timeoutMs, resolve);
    });
    await Promise.race([capacityChanged, elapsed]);
    cancelTimeout();
    if (wake !== null) this.authenticationWaiters.delete(wake);
  }

  public async reserveAuthentication(
    admissionKey: string,
    admittedTenantKey: string | null,
    knownCredential: boolean,
  ): Promise<(() => void) | null> {
    if (this.stopped) return null;
    const immediate: (() => void) | null = this.tryReserveAuthentication(
      admissionKey,
      admittedTenantKey,
      knownCredential,
    );
    if (immediate !== null || !knownCredential) return immediate;
    const pendingForTenant: number =
      admittedTenantKey === null
        ? 0
        : (this.pendingAuthenticationsByTenant.get(admittedTenantKey) ?? 0);
    const owner: boolean = isOwnerAuthentication(
      this.config.ownerPriority,
      admittedTenantKey,
      knownCredential,
    );
    if (
      this.pendingAuthentications >=
        admittedGlobalLimit(
          this.config.maxPendingAuthentications,
          this.config.ownerPriority,
          owner,
        ) ||
      (admittedTenantKey !== null &&
        pendingForTenant >=
          admittedScopeLimit(
            this.config.maxPendingAuthentications,
            this.config.maxPendingAuthenticationsPerTenant,
            owner,
          ))
    ) {
      return null;
    }
    this.pendingAuthentications += 1;
    if (admittedTenantKey !== null) {
      this.pendingAuthenticationsByTenant.set(admittedTenantKey, pendingForTenant + 1);
    }
    const deadline: number = this.time.now() + this.config.authenticationWaitMs;
    try {
      while (!this.stopped && this.time.now() < deadline) {
        const reservation: (() => void) | null = this.tryReserveAuthentication(
          admissionKey,
          admittedTenantKey,
          knownCredential,
        );
        if (reservation !== null) return reservation;
        const remainingMs: number = deadline - this.time.now();
        if (remainingMs > 0) await this.waitForAuthenticationCapacity(remainingMs);
      }
      return null;
    } finally {
      this.pendingAuthentications -= 1;
      if (admittedTenantKey !== null) {
        const remaining: number =
          (this.pendingAuthenticationsByTenant.get(admittedTenantKey) ?? 1) - 1;
        if (remaining === 0) this.pendingAuthenticationsByTenant.delete(admittedTenantKey);
        else this.pendingAuthenticationsByTenant.set(admittedTenantKey, remaining);
      }
    }
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.notifyAuthenticationCapacityChanged();
  }
}
