import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  CREDENTIAL_ADMISSION_TTL_MS,
  CredentialAdmissionCache,
} from "../src/hosted/credential-admission-cache.js";
import { HostedAuthenticator } from "../src/hosted/hosted-authenticator.js";
import {
  OWNER_ADMISSION_REFRESH_MS,
  OwnerCredentialAdmissions,
} from "../src/hosted/owner-credential-admissions.js";
import {
  credentialAdmissionKey,
  generateTokenSecret,
  type HostedTokenSecret,
} from "../src/hosted/token-secret.js";
import { HttpCapacityController } from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";
import { POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS } from "../src/postgres-runtime.js";

type Wake = { readonly milliseconds: number; readonly wake: () => void };
class Schedule {
  public readonly pending: Set<Wake> = new Set<Wake>();

  public schedule(milliseconds: number, wake: () => void): () => void {
    const timer: Wake = { milliseconds, wake };
    this.pending.add(timer);
    return (): void => {
      this.pending.delete(timer);
    };
  }

  public fire(milliseconds: number): void {
    for (const timer of Array.from(this.pending)) {
      if (timer.milliseconds === milliseconds) {
        this.pending.delete(timer);
        timer.wake();
      }
    }
  }
}

class Database {
  public admissionRows: unknown = [];
  public authenticationRows: unknown = [];
  public admissionFailure: Error | null = null;
  public authenticationFailure: Error | null = null;
  public admissions: number = 0;
  public onAdmission: () => void = (): void => {};
  public authentications: number = 0;
  public cancellations: number = 0;
  public cancelPending: () => void = (): void => {};
  public readonly database: Sql;
  private readonly backing: Sql;

  public constructor() {
    this.backing = postgres({ host: "127.0.0.1", max: 1, port: 1 });
    this.database = new Proxy(this.backing, {
      apply: (
        _target: Sql,
        _receiver: unknown,
        argumentsList: readonly unknown[],
      ): Promise<unknown> => {
        const fragments: string[] = z.array(z.string()).parse(argumentsList[0]);
        if (!fragments.join("").includes("founding_owner_admission_keys")) {
          this.authentications += 1;
          return this.authenticationFailure === null
            ? Promise.resolve(this.authenticationRows)
            : Promise.reject(this.authenticationFailure);
        }
        this.admissions += 1;
        this.onAdmission();
        const result: Promise<unknown> =
          this.admissionFailure === null
            ? Promise.resolve(this.admissionRows)
            : Promise.reject(this.admissionFailure);
        return Object.assign(result, {
          cancel: (): void => {
            this.cancellations += 1;
            this.cancelPending();
          },
        });
      },
    });
  }

  public async close(): Promise<void> {
    await this.backing.end({ timeout: 1 });
  }
}

function ownerRows(token: HostedTokenSecret): { readonly admission_key: string }[] {
  return [{ admission_key: credentialAdmissionKey(token.secret) }];
}

function ownerAuthentication(token: HostedTokenSecret): unknown {
  return [
    {
      key_id: token.keyId,
      machine_name: null,
      orchestrator_agent_id: null,
      personal_id: randomUUID(),
      principal_kind: "tenant",
      repository_name: null,
      tenant_id: FOUNDING_TENANT_ID,
      token_id: randomUUID(),
      token_role: "agent",
    },
  ];
}

function release(reservation: (() => void) | null): () => void {
  if (reservation === null) throw new Error("Expected owner authentication reservation");
  return reservation;
}

test("startup owner hints survive ordinary TTL and admit a cold owner under ordinary saturation", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  const token: HostedTokenSecret = generateTokenSecret("mur");
  database.admissionRows = ownerRows(token);
  database.authenticationRows = ownerAuthentication(token);
  let now: number = 0;
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => 0,
  );
  const authenticator: HostedAuthenticator = new HostedAuthenticator(
    database.database,
    new CredentialAdmissionCache({ now: (): number => now }),
    source,
  );
  const capacity: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({ MURMUR_OWNER_PRIORITY: "1" }),
  );
  const releases: (() => void)[] = [];
  try {
    await authenticator.start();
    expect(database.authentications).toBe(0);
    now = CREDENTIAL_ADMISSION_TTL_MS + 1;
    const admission: ReturnType<HostedAuthenticator["credentialAdmission"]> =
      authenticator.credentialAdmission(token.secret);
    if (admission === null) throw new Error("Expected seeded owner hint");
    expect(admission.tenantKey).toBe(credentialAdmissionKey(FOUNDING_TENANT_ID));
    for (let index: number = 0; index < 3; index += 1) {
      releases.push(
        release(await capacity.reserveAuthentication(`ordinary-${index}`, `tenant-${index}`, true)),
      );
    }
    releases.push(
      release(await capacity.reserveAuthentication(admission.key, admission.tenantKey, true)),
    );
    expect(await authenticator.authenticate(token.secret)).toMatchObject({
      kind: "tenant",
      tenantId: { value: FOUNDING_TENANT_ID },
    });
    expect(database.authentications).toBe(1);
    expect(authenticator.credentialAdmission(`mur_${token.keyId}_${"x".repeat(43)}`)).toBeNull();
    expect(authenticator.credentialAdmission("malformed")).toBeNull();
    database.authenticationFailure = new Error("Transient backend failure");
    await expect(authenticator.authenticate(token.secret)).rejects.toThrow(
      "Transient backend failure",
    );
    expect(authenticator.credentialAdmission(token.secret)).not.toBeNull();
    database.authenticationFailure = null;
    database.admissionFailure = new Error("Post-mutation hint maintenance failed");
    await authenticator.refresh();
    expect(authenticator.credentialAdmission(token.secret)).not.toBeNull();
    database.admissionFailure = null;
    database.authenticationRows = [];
    expect(await authenticator.authenticate(token.secret)).toBeNull();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
  } finally {
    capacity.stop();
    for (const finish of releases) finish();
    await authenticator.close();
    expect(scheduler.pending.size).toBe(0);
    await database.close();
  }
});

test("owner polling preserves trusted snapshot on failure then adopts new keys", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  const original: HostedTokenSecret = generateTokenSecret("mur");
  const replacement: HostedTokenSecret = generateTokenSecret("mur");
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => 0,
  );
  database.admissionRows = ownerRows(original);
  try {
    await source.start();
    database.admissionFailure = new Error("Unavailable");
    scheduler.fire(OWNER_ADMISSION_REFRESH_MS);
    await expect(source.refresh()).rejects.toThrow("Unavailable");
    expect(source.get(credentialAdmissionKey(original.secret))).not.toBeNull();
    database.admissionFailure = null;
    database.admissionRows = ownerRows(replacement);
    await source.refresh();
    expect(source.get(credentialAdmissionKey(original.secret))).toBeNull();
    expect(source.get(credentialAdmissionKey(replacement.secret))).not.toBeNull();
    source.forget(credentialAdmissionKey(replacement.secret));
    expect(source.get(credentialAdmissionKey(replacement.secret))).toBeNull();
    await source.close();
    await source.close();
    expect(scheduler.pending.size).toBe(0);
    expect(source.get(credentialAdmissionKey(original.secret))).toBeNull();
    await source.refresh();
  } finally {
    await source.close();
    await database.close();
  }
});

test("owner snapshot rejects malformed and oversized results without replacing prior trusted keys", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  const token: HostedTokenSecret = generateTokenSecret("mur");
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => 0,
  );
  database.admissionRows = ownerRows(token);
  try {
    await source.start();
    for (const invalid of [
      [{ admission_key: token.hash.toString("hex"), secret_hash: token.hash }],
      [{ admission_key: "bad" }],
      Array.from({ length: 1_001 }, (): { readonly admission_key: string } => ({
        admission_key: credentialAdmissionKey(token.secret),
      })),
    ]) {
      database.admissionRows = invalid;
      await expect(source.refresh()).rejects.toThrow();
      expect(source.get(credentialAdmissionKey(token.secret))).not.toBeNull();
    }
  } finally {
    await source.close();
    await database.close();
  }
});

test("overlapping mutation refreshes reread once after the original snapshot", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  const token: HostedTokenSecret = generateTokenSecret("mur");
  const deferred: ReturnType<typeof Promise.withResolvers<unknown>> =
    Promise.withResolvers<unknown>();
  database.admissionRows = deferred.promise;
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => 0,
  );
  try {
    const initial: Promise<void> = source.refresh();
    const updates: Promise<void>[] = Array.from(
      { length: 25 },
      (): Promise<void> => source.refresh(),
    );
    database.admissionRows = ownerRows(token);
    deferred.resolve([]);
    await Promise.all([initial, ...updates]);
    expect(database.admissions).toBe(2);
    expect(source.get(credentialAdmissionKey(token.secret))).not.toBeNull();
  } finally {
    deferred.resolve([]);
    await source.close();
    await database.close();
  }
});

test("owner lookup cancellation has an absolute deadline and cannot repopulate after close", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  const token: HostedTokenSecret = generateTokenSecret("mur");
  const deferred: ReturnType<typeof Promise.withResolvers<unknown>> =
    Promise.withResolvers<unknown>();
  database.admissionRows = deferred.promise;
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => 0,
  );
  try {
    const initial: Promise<void> = source.refresh();
    scheduler.fire(POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS);
    await expect(initial).rejects.toThrow("deadline exceeded");
    expect(database.cancellations).toBe(1);
    const next: Promise<void> = source.refresh();
    const closing: Promise<void> = source.close();
    deferred.resolve(ownerRows(token));
    await Promise.all([next, closing]);
    expect(source.get(credentialAdmissionKey(token.secret))).toBeNull();
    expect(database.cancellations).toBe(2);
    expect(scheduler.pending.size).toBe(0);
  } finally {
    deferred.resolve([]);
    await source.close();
    await database.close();
  }
});

test("continuous mutation refresh requests cannot trigger more than two scans", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  const first: ReturnType<typeof Promise.withResolvers<unknown>> = Promise.withResolvers<unknown>();
  const second: ReturnType<typeof Promise.withResolvers<unknown>> =
    Promise.withResolvers<unknown>();
  const secondStarted: ReturnType<typeof Promise.withResolvers<void>> =
    Promise.withResolvers<void>();
  database.admissionRows = first.promise;
  database.onAdmission = (): void => {
    if (database.admissions === 2) secondStarted.resolve();
  };
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => 0,
  );
  try {
    const running: Promise<void> = source.refresh();
    const pending: Promise<void>[] = [source.refresh()];
    database.admissionRows = second.promise;
    first.resolve([]);
    await secondStarted.promise;
    for (let index: number = 0; index < 25; index += 1) pending.push(source.refresh());
    second.resolve([]);
    await Promise.all([running, ...pending]);
    expect(database.admissions).toBe(2);
  } finally {
    first.resolve([]);
    second.resolve([]);
    await source.close();
    await database.close();
  }
});

test("a follow-up owner scan shares the original refresh deadline", async (): Promise<void> => {
  const database: Database = new Database();
  const scheduler: Schedule = new Schedule();
  let now: number = 0;
  const first: ReturnType<typeof Promise.withResolvers<unknown>> = Promise.withResolvers<unknown>();
  const second: ReturnType<typeof Promise.withResolvers<unknown>> =
    Promise.withResolvers<unknown>();
  const secondStarted: ReturnType<typeof Promise.withResolvers<void>> =
    Promise.withResolvers<void>();
  database.admissionRows = first.promise;
  database.onAdmission = (): void => {
    if (database.admissions === 2) secondStarted.resolve();
  };
  const source: OwnerCredentialAdmissions = new OwnerCredentialAdmissions(
    database.database,
    scheduler.schedule.bind(scheduler),
    (): number => now,
  );
  try {
    const running: Promise<void> = source.refresh();
    const pending: Promise<void> = source.refresh();
    now = POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS - 1;
    database.admissionRows = second.promise;
    first.resolve([]);
    await secondStarted.promise;
    scheduler.fire(1);
    await expect(running).rejects.toThrow("deadline exceeded");
    await expect(pending).rejects.toThrow("deadline exceeded");
    expect(database.admissions).toBe(2);
    expect(database.cancellations).toBe(1);
  } finally {
    first.resolve([]);
    second.resolve([]);
    await source.close();
    await database.close();
  }
});
