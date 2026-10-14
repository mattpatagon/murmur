import { logSafeError } from "../safe-errors.js";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "./http-capacity.js";
import type { HttpServerConfig } from "./http-config.js";
import { admittedGlobalLimit, admittedScopeLimit, isOwnerTenant } from "./owner-capacity-policy.js";
import type { RemoteSession } from "./remote-session.js";
import { closeResources } from "./resource-lifecycle.js";

export type RetirableSession = Pick<RemoteSession, "lastSeenAt" | "tenantId"> & {
  readonly application: { close(): Promise<void> };
  readonly transport: { close(): Promise<void> };
};

const SESSION_REPLACEMENT_DEADLINE_MS: number = 5_000;

export type SessionAdmission =
  | { readonly kind: "rejected"; readonly scope: "global" | "tenant" }
  | { readonly kind: "admitted"; readonly release: () => void };

export class SessionAdmissionController {
  private pending: number = 0;
  private readonly pendingByTenant: Map<string, number> = new Map<string, number>();
  private readonly sessions: Map<string, RetirableSession>;
  private readonly config: HttpServerConfig;
  private readonly time: TimeSource;

  public constructor(
    sessions: Map<string, RetirableSession>,
    config: HttpServerConfig,
    time: TimeSource = SYSTEM_TIME_SOURCE,
  ) {
    this.sessions = sessions;
    this.config = config;
    this.time = time;
  }

  public reserve(tenantId: string | null): SessionAdmission {
    const owner: boolean = isOwnerTenant(this.config.ownerPriority, tenantId);
    if (
      this.sessions.size + this.pending >=
      admittedGlobalLimit(this.config.maxSessions, this.config.ownerPriority, owner)
    ) {
      return { kind: "rejected", scope: "global" };
    }
    const pendingForTenant: number =
      tenantId === null ? 0 : (this.pendingByTenant.get(tenantId) ?? 0);
    if (tenantId !== null) {
      let established: number = 0;
      for (const session of this.sessions.values()) {
        if (session.tenantId === tenantId) established += 1;
      }
      if (
        established + pendingForTenant >=
        admittedScopeLimit(this.config.maxSessions, this.config.maxSessionsPerTenant, owner)
      ) {
        return { kind: "rejected", scope: "tenant" };
      }
    }
    // Reserve before application construction can yield to another initializer.
    this.pending += 1;
    if (tenantId !== null) this.pendingByTenant.set(tenantId, pendingForTenant + 1);
    let released: boolean = false;
    return {
      kind: "admitted",
      release: (): void => {
        if (released) return;
        released = true;
        this.pending -= 1;
        if (tenantId !== null) {
          const remaining: number = (this.pendingByTenant.get(tenantId) ?? 1) - 1;
          if (remaining === 0) this.pendingByTenant.delete(tenantId);
          else this.pendingByTenant.set(tenantId, remaining);
        }
      },
    };
  }

  public async reserveReplacingOldest(tenantId: string | null): Promise<SessionAdmission> {
    const initial: SessionAdmission = this.reserve(tenantId);
    if (initial.kind === "admitted" || !isOwnerTenant(this.config.ownerPriority, tenantId))
      return initial;
    const oldest: { readonly key: string; readonly session: RetirableSession } | null =
      this.oldestSession();
    if (oldest === null) return initial;
    // Transfer the established slot to pending before cleanup can yield. A concurrent
    // initializer cannot reuse either the retired identity or its physical allowance.
    this.sessions.delete(oldest.key);
    const replacement: SessionAdmission = this.reserve(tenantId);
    if (replacement.kind === "rejected") {
      this.sessions.set(oldest.key, oldest.session);
      return replacement;
    }
    const cleanup: Promise<boolean> = this.closeRetiredSession(oldest.session);
    let cancelDeadline: () => void = (): void => {};
    const deadline: Promise<boolean> = new Promise((resolve: (value: boolean) => void): void => {
      cancelDeadline = this.time.schedule(SESSION_REPLACEMENT_DEADLINE_MS, (): void => {
        logSafeError(
          "Murmur owner session replacement deadline exceeded",
          new Error("Session cleanup timed out"),
        );
        resolve(false);
      });
    });
    const closed: boolean = await Promise.race([cleanup, deadline]);
    cancelDeadline();
    if (closed) return replacement;
    // A timeout ends the caller's wait, not the retired transport or its handlers.
    // Keep its slot charged until both cleanup attempts actually settle.
    void cleanup.then((): void => replacement.release());
    return initial;
  }

  private oldestSession(): { readonly key: string; readonly session: RetirableSession } | null {
    let oldest: { readonly key: string; readonly session: RetirableSession } | null = null;
    for (const [key, session] of this.sessions) {
      if (
        oldest === null ||
        session.lastSeenAt < oldest.session.lastSeenAt ||
        (session.lastSeenAt === oldest.session.lastSeenAt && key < oldest.key)
      )
        oldest = { key, session };
    }
    return oldest;
  }

  private async closeRetiredSession(session: RetirableSession): Promise<boolean> {
    try {
      await closeResources([
        {
          close: (): Promise<void> => session.transport.close(),
          context: "Murmur replaced session transport cleanup failed",
        },
        {
          close: (): Promise<void> => session.application.close(),
          context: "Murmur replaced session application cleanup failed",
        },
      ]);
      return true;
    } catch (_error: unknown) {
      // closeResources logged each redacted failure and attempted every cleanup.
      return false;
    }
  }
}
