import type { HttpServerConfig } from "./http-config.js";
import type { RemoteSession } from "./remote-session.js";

export type SessionAdmission =
  | { readonly kind: "rejected"; readonly scope: "global" | "tenant" }
  | { readonly kind: "admitted"; readonly release: () => void };

export class SessionAdmissionController {
  private pending: number = 0;
  private readonly pendingByTenant: Map<string, number> = new Map<string, number>();
  private readonly sessions: ReadonlyMap<string, RemoteSession>;
  private readonly config: HttpServerConfig;

  public constructor(sessions: ReadonlyMap<string, RemoteSession>, config: HttpServerConfig) {
    this.sessions = sessions;
    this.config = config;
  }

  public reserve(tenantId: string | null): SessionAdmission {
    if (this.sessions.size + this.pending >= this.config.maxSessions) {
      return { kind: "rejected", scope: "global" };
    }
    const pendingForTenant: number =
      tenantId === null ? 0 : (this.pendingByTenant.get(tenantId) ?? 0);
    if (tenantId !== null) {
      let established: number = 0;
      for (const session of this.sessions.values()) {
        if (session.tenantId === tenantId) established += 1;
      }
      if (established + pendingForTenant >= this.config.maxSessionsPerTenant) {
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
}
