import type { TenantId } from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type { RemoteSession } from "./remote-session.js";

export type SessionAuthorizationEpoch = {
  readonly tenantEpoch: number | null;
  readonly tenantId: string | null;
  readonly tokenEpoch: number;
  readonly tokenId: string;
};

export class RemoteSessionInvalidator {
  readonly #sessions: Map<string, RemoteSession>;
  readonly #tenantEpochs: Map<string, number> = new Map<string, number>();
  readonly #tokenEpochs: Map<string, number> = new Map<string, number>();

  public constructor(sessions: Map<string, RemoteSession>) {
    this.#sessions = sessions;
  }

  public capture(tenantId: string | null, tokenId: string): SessionAuthorizationEpoch {
    return {
      tenantEpoch: tenantId === null ? null : this.#epoch(this.#tenantEpochs, tenantId),
      tenantId,
      tokenEpoch: this.#epoch(this.#tokenEpochs, tokenId),
      tokenId,
    };
  }

  public changed(captured: SessionAuthorizationEpoch): boolean {
    return (
      this.#epoch(this.#tokenEpochs, captured.tokenId) !== captured.tokenEpoch ||
      (captured.tenantId !== null &&
        captured.tenantEpoch !== null &&
        this.#epoch(this.#tenantEpochs, captured.tenantId) !== captured.tenantEpoch)
    );
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
    this.#advance(this.#tenantEpochs, tenantId.value);
    this.#schedule(
      Array.from(this.#sessions.entries()).filter(
        (entry: [string, RemoteSession]): boolean => entry[1].tenantId === tenantId.value,
      ),
      "Murmur suspended-tenant session shutdown failed",
    );
  }

  public async invalidateToken(tokenId: string): Promise<void> {
    this.#advance(this.#tokenEpochs, tokenId);
    this.#schedule(
      Array.from(this.#sessions.entries()).filter(
        (entry: [string, RemoteSession]): boolean => entry[1].tokenId === tokenId,
      ),
      "Murmur revoked-session shutdown failed",
    );
  }

  #advance(epochs: Map<string, number>, key: string): void {
    epochs.set(key, this.#epoch(epochs, key) + 1);
  }

  #epoch(epochs: ReadonlyMap<string, number>, key: string): number {
    return epochs.get(key) ?? 0;
  }

  #schedule(matches: readonly [string, RemoteSession][], context: string): void {
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
