import type { CredentialAdmission } from "./control-plane-contracts.js";

export const MAX_CACHED_CREDENTIAL_ADMISSIONS: number = 32_768;
export const CREDENTIAL_ADMISSION_TTL_MS: number = 5 * 60_000;

type CachedAdmission = {
  readonly admission: CredentialAdmission;
  readonly expiresAt: number;
};

type AdmissionCacheOptions = {
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly ttlMs?: number;
};

export class CredentialAdmissionCache {
  private readonly entries: Map<string, CachedAdmission>;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(options: AdmissionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_CACHED_CREDENTIAL_ADMISSIONS;
    this.ttlMs = options.ttlMs ?? CREDENTIAL_ADMISSION_TTL_MS;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      this.maxEntries > MAX_CACHED_CREDENTIAL_ADMISSIONS ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1 ||
      this.ttlMs > CREDENTIAL_ADMISSION_TTL_MS
    ) {
      throw new Error("Invalid credential admission cache bounds");
    }
    this.now = options.now ?? Date.now;
    this.entries = new Map<string, CachedAdmission>();
  }

  public get(key: string): CredentialAdmission | null {
    const cached: CachedAdmission | undefined = this.entries.get(key);
    if (cached === undefined) return null;
    if (cached.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return cached.admission;
  }

  public remember(admission: CredentialAdmission): void {
    // Only authoritative authentication renews age and recency; admission reads cannot do so.
    this.entries.delete(admission.key);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey: string | undefined = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(admission.key, {
      admission,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  public forget(key: string): void {
    this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
  }
}
