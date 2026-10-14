import type { PendingQuery, Sql } from "postgres";
import { z } from "zod";

import { FOUNDING_TENANT_ID } from "../domain/value-objects.js";
import { POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS } from "../postgres-runtime.js";
import { logSafeError } from "../safe-errors.js";
import type { CredentialAdmission } from "./control-plane-contracts.js";
import { credentialAdmissionKey } from "./token-secret.js";

export const MAX_OWNER_CREDENTIAL_ADMISSIONS: number = 1_000;
export const OWNER_ADMISSION_REFRESH_MS: number = 60_000;
const OWNER_TENANT_KEY: string = credentialAdmissionKey(FOUNDING_TENANT_ID);
type AdmissionRow = { readonly admission_key: string };
const AdmissionRowsSchema: z.ZodType<AdmissionRow[]> = z
  .array(z.strictObject({ admission_key: z.string().regex(/^[a-f0-9]{64}$/u) }))
  .max(MAX_OWNER_CREDENTIAL_ADMISSIONS);

type Scheduler = (milliseconds: number, wake: () => void) => () => void;

function schedule(milliseconds: number, wake: () => void): () => void {
  const timer: ReturnType<typeof setTimeout> = setTimeout(wake, milliseconds);
  timer.unref();
  return (): void => clearTimeout(timer);
}

export class OwnerCredentialAdmissions {
  private readonly database: Sql;
  private readonly schedule: Scheduler;
  private readonly now: () => number;
  private keys: Set<string> = new Set<string>();
  private closed: boolean = false;
  private cancelPoll: () => void = (): void => {};
  private cancelQuery: () => void = (): void => {};
  private pending: Promise<void> | null = null;
  private reloadRequested: boolean = false;

  public constructor(database: Sql, scheduler: Scheduler = schedule, now: () => number = Date.now) {
    this.database = database;
    this.schedule = scheduler;
    this.now = now;
  }

  public get(key: string): CredentialAdmission | null {
    return !this.closed && this.keys.has(key) ? { key, tenantKey: OWNER_TENANT_KEY } : null;
  }

  public forget(key: string): void {
    this.keys.delete(key);
  }

  public async start(): Promise<void> {
    await this.refresh();
    if (!this.closed) this.poll();
  }

  public refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending !== null) {
      this.reloadRequested = true;
      return this.pending;
    }
    const deadline: number = this.now() + POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS;
    const pending: Promise<void> = this.loadRequested(deadline).finally((): void => {
      this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async loadRequested(deadline: number): Promise<void> {
    this.reloadRequested = false;
    await this.load(deadline);
    // One follow-up catches mutations during the first snapshot without letting a
    // continuous mutation stream keep an administrative response pending forever.
    if (this.reloadRequested && !this.closed) {
      this.reloadRequested = false;
      await this.load(deadline);
    }
  }

  private async load(absoluteDeadline: number): Promise<void> {
    const remainingMs: number = absoluteDeadline - this.now();
    if (remainingMs <= 0) throw new Error("Owner credential admission refresh deadline exceeded");
    const query: PendingQuery<AdmissionRow[]> = this.database<AdmissionRow[]>`
      SELECT admission_key FROM murmur.founding_owner_admission_keys()
    `;
    this.cancelQuery = (): void => query.cancel();
    let cancelDeadline: () => void = (): void => {};
    const deadline: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (reason: Error) => void): void => {
        cancelDeadline = this.schedule(remainingMs, (): void => {
          reject(new Error("Owner credential admission refresh deadline exceeded"));
          query.cancel();
        });
      },
    );
    try {
      const raw: unknown = await Promise.race([query, deadline]);
      const rows: AdmissionRow[] = AdmissionRowsSchema.parse(raw);
      if (!this.closed)
        this.keys = new Set<string>(rows.map((row: AdmissionRow): string => row.admission_key));
    } finally {
      cancelDeadline();
      this.cancelQuery = (): void => {};
    }
  }

  private poll(): void {
    this.cancelPoll();
    this.cancelPoll = this.schedule(OWNER_ADMISSION_REFRESH_MS, (): void => {
      // A failed refresh preserves trusted admission hints, never cached authorization.
      // Retry on the next bounded interval while every bearer token is reauthenticated.
      void this.refresh()
        .catch((error: unknown): void => {
          logSafeError("Murmur owner credential admission refresh failed", error);
        })
        .finally((): void => {
          if (!this.closed) this.poll();
        });
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.keys.clear();
    this.cancelPoll();
    this.cancelQuery();
    if (this.pending !== null) {
      // Closing cancels the query; its absolute deadline bounds unsuccessful cancellation.
      await this.pending.catch((error: unknown): void => {
        if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "57014") {
          logSafeError("Murmur owner credential admission cleanup failed", error);
        }
      });
    }
  }
}
