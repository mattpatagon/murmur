import { expect, test } from "bun:test";

import { TenantId } from "../src/domain/value-objects.js";
import type { RemoteSession } from "../src/http/remote-session.js";
import {
  RemoteSessionInvalidator,
  type SessionAuthorizationEpoch,
} from "../src/http/session-invalidation.js";

test("completed initializations stop retaining authorization history", async (): Promise<void> => {
  const invalidator: RemoteSessionInvalidator = new RemoteSessionInvalidator(
    new Map<string, RemoteSession>(),
  );
  const tenantId: TenantId = TenantId.founding();
  const completed: SessionAuthorizationEpoch = invalidator.capture(tenantId.value, "completed");
  invalidator.release(completed);
  invalidator.release(completed);
  const pending: SessionAuthorizationEpoch = invalidator.capture(tenantId.value, "pending");
  await invalidator.invalidateTenant(tenantId);
  expect(invalidator.changed(completed)).toBe(false);
  expect(invalidator.changed(pending)).toBe(true);
  invalidator.release(pending);
  expect(invalidator.changed(pending)).toBe(false);
});

test("revocation only invalidates matching in-flight credentials", async (): Promise<void> => {
  const invalidator: RemoteSessionInvalidator = new RemoteSessionInvalidator(
    new Map<string, RemoteSession>(),
  );
  const revoked: SessionAuthorizationEpoch = invalidator.capture(null, "revoked");
  const unrelated: SessionAuthorizationEpoch = invalidator.capture(null, "unrelated");
  await invalidator.invalidateToken("revoked");
  expect(invalidator.changed(revoked)).toBe(true);
  expect(invalidator.changed(unrelated)).toBe(false);
  invalidator.release(revoked);
  invalidator.release(unrelated);
  const fresh: SessionAuthorizationEpoch = invalidator.capture(null, "revoked");
  expect(invalidator.changed(fresh)).toBe(false);
  invalidator.release(fresh);
});
