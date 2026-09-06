import type { TenantId } from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type { RemoteSession } from "./remote-session.js";

export type SessionAuthorizationEpoch = {
  readonly tenantId: string | null;
  readonly tokenId: string;
};

export class RemoteSessionInvalidator {
  readonly #sessions: Map<string, RemoteSession>;
  readonly #pending: Set<SessionAuthorizationEpoch> = new Set<SessionAuthorizationEpoch>();
  readonly #invalidated: WeakSet<SessionAuthorizationEpoch> =
    new WeakSet<SessionAuthorizationEpoch>();

  public constructor(sessions: Map<string, RemoteSession>) {
    this.#sessions = sessions;
  }

  public capture(tenantId: string | null, tokenId: string): SessionAuthorizationEpoch {
    const captured: SessionAuthorizationEpoch = { tenantId, tokenId };
    this.#pending.add(captured);
    return captured;
  }

  public changed(captured: SessionAuthorizationEpoch): boolean {
    return this.#invalidated.has(captured);
  }

  public release(captured: SessionAuthorizationEpoch): void {
    this.#pending.delete(captured);
    this.#invalidated.delete(captured);
  }

  public async close(matches: readonly [string, RemoteSession][], context: string): Promise<void> {
    matches.forEach((entry: [string, RemoteSession]): void => {
      this.#sessions.delete(entry[0]);
    });
    const results: PromiseSettledResult<void>[] = await Promise.allSettled(
      matches.map(
        async (entry: [string, RemoteSession]): Promise<void> => await entry[1].application.close(),
      ),
    );
    results.forEach((result: PromiseSettledResult<void>): void => {
      if (result.status === "rejected") logSafeError(context, result.reason);
    });
  }

  public async invalidateTenant(tenantId: TenantId): Promise<void> {
    for (const captured of this.#pending) {
      if (captured.tenantId === tenantId.value) this.#invalidated.add(captured);
    }
    this.#schedule(
      Array.from(this.#sessions.entries()).filter(
        (entry: [string, RemoteSession]): boolean => entry[1].tenantId === tenantId.value,
      ),
      "Murmur suspended-tenant session shutdown failed",
    );
  }

  public async invalidateToken(tokenId: string): Promise<void> {
    for (const captured of this.#pending) {
      if (captured.tokenId === tokenId) this.#invalidated.add(captured);
    }
    this.#schedule(
      Array.from(this.#sessions.entries()).filter(
        (entry: [string, RemoteSession]): boolean => entry[1].tokenId === tokenId,
      ),
      "Murmur revoked-session shutdown failed",
    );
  }

  #schedule(matches: readonly [string, RemoteSession][], context: string): void {
    if (matches.length === 0) return;
    matches.forEach((entry: [string, RemoteSession]): void => {
      this.#sessions.delete(entry[0]);
    });
    setTimeout((): void => {
      void this.close(matches, context).catch((error: unknown): void => {
        logSafeError(context, error);
      });
    }, 0);
  }
}
