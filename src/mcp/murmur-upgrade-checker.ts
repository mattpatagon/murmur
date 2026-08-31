import packageMetadata from "../../package.json" with { type: "json" };
import {
  type CheckForUpgradesOutput,
  createUpgradeCheckOutput,
  type MurmurReleaseMetadata,
  MurmurReleaseMetadataSchema,
  MurmurVersionSchema,
} from "../domain/upgrade-contracts.js";
import { logSafeError } from "../safe-errors.js";

const CACHE_TTL_MS: number = 5 * 60 * 1_000;
const CHECK_TIMEOUT_MS: number = 5_000;
const FAILURE_CACHE_TTL_MS: number = 30_000;
const MAX_RELEASE_BYTES: number = 1_024;
const OFFICIAL_RELEASE_URL: string = "https://api.usemurmur.dev/version";

type UpgradeFetch = (url: string, init: RequestInit) => Promise<Response>;

type UpgradeCache = {
  readonly expiresAt: number;
  readonly output: CheckForUpgradesOutput;
};

export type MurmurUpgradeChecker = {
  checkForUpgrades(): Promise<CheckForUpgradesOutput>;
};

export type MurmurUpgradeCheckerOptions = {
  readonly cacheTtlMs?: number | undefined;
  readonly currentVersion: string;
  readonly fetch: UpgradeFetch;
  readonly now?: (() => Date) | undefined;
};

function mediaType(response: Response): string {
  const contentType: string | null = response.headers.get("content-type");
  if (contentType === null) return "";
  const separator: number = contentType.indexOf(";");
  return (separator === -1 ? contentType : contentType.slice(0, separator)).trim().toLowerCase();
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel();
}

function validateDeclaredLength(response: Response, maximumBytes: number): void {
  const rawLength: string | null = response.headers.get("content-length");
  if (rawLength === null) return;
  if (!/^\d+$/u.test(rawLength)) throw new Error("Upgrade response length is invalid");
  const length: number = Number(rawLength);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new Error("Upgrade response exceeds its size limit");
  }
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  try {
    validateDeclaredLength(response, maximumBytes);
  } catch (error: unknown) {
    await cancelResponse(response);
    throw error;
  }
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  try {
    while (true) {
      const result: { readonly done: boolean; readonly value?: Uint8Array | undefined } =
        await reader.read();
      if (result.done) break;
      const value: Uint8Array | undefined = result.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("Upgrade response exceeds its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  chunks.forEach((chunk: Uint8Array): void => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requestHeaders(): Headers {
  const headers: Headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("user-agent", "murmur-upgrade-check");
  return headers;
}

class CachedMurmurUpgradeChecker implements MurmurUpgradeChecker {
  readonly #cacheTtlMs: number;
  readonly #currentVersion: string;
  readonly #fetch: UpgradeFetch;
  readonly #now: () => Date;
  #cache: UpgradeCache | null = null;
  #failureExpiresAt: number = 0;
  #inFlight: Promise<CheckForUpgradesOutput> | null = null;

  public constructor(options: MurmurUpgradeCheckerOptions) {
    const cacheTtlMs: number = options.cacheTtlMs ?? CACHE_TTL_MS;
    if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60 * 60 * 1_000) {
      throw new Error("Murmur upgrade cache duration is invalid");
    }
    this.#cacheTtlMs = cacheTtlMs;
    this.#currentVersion = MurmurVersionSchema.parse(options.currentVersion);
    this.#fetch = options.fetch;
    this.#now = options.now ?? ((): Date => new Date());
  }

  private async readRelease(signal: AbortSignal): Promise<MurmurReleaseMetadata> {
    const response: Response = await this.#fetch(OFFICIAL_RELEASE_URL, {
      headers: requestHeaders(),
      method: "GET",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await cancelResponse(response);
      throw new Error("Upgrade release request failed");
    }
    if (mediaType(response) !== "application/json") {
      await cancelResponse(response);
      throw new Error("Upgrade release response type is invalid");
    }
    const text: string = await boundedResponseText(response, MAX_RELEASE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (_error: unknown) {
      throw new Error("Upgrade release response is invalid");
    }
    return MurmurReleaseMetadataSchema.parse(value);
  }

  private async refresh(): Promise<CheckForUpgradesOutput> {
    try {
      const signal: AbortSignal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
      const release: MurmurReleaseMetadata = await this.readRelease(signal);
      const checkedAt: Date = this.#now();
      const output: CheckForUpgradesOutput = createUpgradeCheckOutput(
        this.#currentVersion,
        release.version,
        release.revision,
        checkedAt,
      );
      this.#cache = {
        expiresAt: checkedAt.getTime() + this.#cacheTtlMs,
        output,
      };
      this.#failureExpiresAt = 0;
      return output;
    } catch (error: unknown) {
      this.#failureExpiresAt = this.#now().getTime() + FAILURE_CACHE_TTL_MS;
      logSafeError("Murmur upgrade check failed", error);
      throw new Error("Murmur could not check for upgrades right now");
    }
  }

  public async checkForUpgrades(): Promise<CheckForUpgradesOutput> {
    const now: number = this.#now().getTime();
    const cache: UpgradeCache | null = this.#cache;
    if (cache !== null && now < cache.expiresAt) return cache.output;
    if (now < this.#failureExpiresAt) {
      throw new Error("Murmur could not check for upgrades right now");
    }
    const pending: Promise<CheckForUpgradesOutput> | null = this.#inFlight;
    if (pending !== null) return await pending;
    const refresh: Promise<CheckForUpgradesOutput> = this.refresh();
    this.#inFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#inFlight === refresh) this.#inFlight = null;
    }
  }
}

export function createMurmurUpgradeChecker(
  options: MurmurUpgradeCheckerOptions,
): MurmurUpgradeChecker {
  return new CachedMurmurUpgradeChecker(options);
}

export const defaultMurmurUpgradeChecker: MurmurUpgradeChecker = createMurmurUpgradeChecker({
  currentVersion: packageMetadata.version,
  fetch: async (url: string, init: RequestInit): Promise<Response> => await fetch(url, init),
});
