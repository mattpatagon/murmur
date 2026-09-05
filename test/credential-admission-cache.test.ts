import { expect, test } from "bun:test";

import {
  CredentialAdmissionCache,
  MAX_CACHED_CREDENTIAL_ADMISSIONS,
} from "../src/hosted/credential-admission-cache.js";
import { credentialAdmissionKey } from "../src/hosted/token-secret.js";

test("credential admissions expire exactly at their deadline without lookup extending it", (): void => {
  let now: number = 100;
  const cache: CredentialAdmissionCache = new CredentialAdmissionCache({
    now: (): number => now,
    ttlMs: 10,
  });
  const key: string = credentialAdmissionKey("first credential");
  cache.remember({ key, tenantKey: null });
  now = 109;
  expect(cache.get(key)).toEqual({ key, tenantKey: null });
  now = 110;
  expect(cache.get(key)).toBeNull();
  now = 100;
  expect(cache.get(key)).toBeNull();
});

test("only successful authentication renews recency and cached tenant attribution", (): void => {
  let now: number = 100;
  const cache: CredentialAdmissionCache = new CredentialAdmissionCache({
    maxEntries: 2,
    now: (): number => now,
    ttlMs: 10,
  });
  const first: string = credentialAdmissionKey("first credential");
  const second: string = credentialAdmissionKey("second credential");
  const third: string = credentialAdmissionKey("third credential");
  const tenant: string = credentialAdmissionKey("authoritative tenant");
  cache.remember({ key: first, tenantKey: null });
  cache.remember({ key: second, tenantKey: null });
  now = 105;
  cache.remember({ key: first, tenantKey: tenant });
  expect(cache.get(second)).not.toBeNull();
  cache.remember({ key: third, tenantKey: null });
  expect(cache.get(second)).toBeNull();
  now = 110;
  expect(cache.get(first)).toEqual({ key: first, tenantKey: tenant });
  now = 115;
  expect(cache.get(first)).toBeNull();
});

test("credential admission memory remains fixed across more than 25k authenticated tenants", (): void => {
  const cache: CredentialAdmissionCache = new CredentialAdmissionCache({ now: (): number => 100 });
  const tenantKey: string = credentialAdmissionKey("tenant");
  const keys: string[] = Array.from(
    { length: MAX_CACHED_CREDENTIAL_ADMISSIONS + 2 },
    (_value: unknown, index: number): string => credentialAdmissionKey(`credential ${index}`),
  );
  for (const key of keys) cache.remember({ key, tenantKey });
  let retained: number = 0;
  for (const key of keys) {
    if (cache.get(key) !== null) retained += 1;
  }
  expect(retained).toBe(MAX_CACHED_CREDENTIAL_ADMISSIONS);
});

test("invalid cache bounds are rejected and cache cleanup is idempotent", (): void => {
  for (const maxEntries of [0, -1, 1.5, Number.NaN, MAX_CACHED_CREDENTIAL_ADMISSIONS + 1]) {
    expect((): CredentialAdmissionCache => new CredentialAdmissionCache({ maxEntries })).toThrow();
  }
  for (const ttlMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 300_001]) {
    expect((): CredentialAdmissionCache => new CredentialAdmissionCache({ ttlMs })).toThrow();
  }
  const cache: CredentialAdmissionCache = new CredentialAdmissionCache();
  const key: string = credentialAdmissionKey("credential");
  cache.remember({ key, tenantKey: null });
  cache.forget(key);
  cache.forget(key);
  expect(cache.get(key)).toBeNull();
  cache.remember({ key, tenantKey: null });
  cache.clear();
  cache.clear();
  expect(cache.get(key)).toBeNull();
});
