import { expect, test } from "bun:test";

import {
  applyE2eeUsageDelta,
  cancelPendingE2eeDeliveries,
  commitPendingE2eeDeliveries,
  emptyE2eeTenantUsage,
  type E2eeTenantQuotas,
  type E2eeTenantUsage,
} from "../src/storage/e2ee-usage.js";

const SMALL_QUOTAS: E2eeTenantQuotas = {
  maxClaimCount: 3,
  maxPendingBroadcastCount: 1,
  maxPendingCiphertextBytes: 1_000,
  maxPendingDeliveryCount: 3,
  maxPublicPrekeyCount: 4,
  maxRetainedCiphertextBytes: 2_000,
  maxRetainedMessageCount: 4,
};

function reserveBroadcast(): E2eeTenantUsage {
  return applyE2eeUsageDelta(
    emptyE2eeTenantUsage(),
    {
      claimCount: 2,
      pendingBroadcastCount: 1,
      pendingCiphertextBytes: 700,
      pendingDeliveryCount: 2,
      publicPrekeyCount: 0,
      retainedCiphertextBytes: 0,
      retainedMessageCount: 0,
    },
    SMALL_QUOTAS,
  );
}

test("reserves every pending resource atomically within explicit tenant quotas", (): void => {
  expect(reserveBroadcast()).toEqual({
    claimCount: 2,
    pendingBroadcastCount: 1,
    pendingCiphertextBytes: 700,
    pendingDeliveryCount: 2,
    publicPrekeyCount: 0,
    retainedCiphertextBytes: 0,
    retainedMessageCount: 0,
  });
  expect(
    (): E2eeTenantUsage =>
      applyE2eeUsageDelta(
        reserveBroadcast(),
        {
          claimCount: 2,
          pendingBroadcastCount: 0,
          pendingCiphertextBytes: 0,
          pendingDeliveryCount: 0,
          publicPrekeyCount: 0,
          retainedCiphertextBytes: 0,
          retainedMessageCount: 0,
        },
        SMALL_QUOTAS,
      ),
  ).toThrow("resource quota exceeded");
});

test("transfers pending broadcast usage to retained ciphertext without double counting", (): void => {
  const pending: E2eeTenantUsage = reserveBroadcast();
  const committed: E2eeTenantUsage = commitPendingE2eeDeliveries(pending, 2, 700);
  expect(committed).toEqual({
    claimCount: 0,
    pendingBroadcastCount: 0,
    pendingCiphertextBytes: 0,
    pendingDeliveryCount: 0,
    publicPrekeyCount: 0,
    retainedCiphertextBytes: 700,
    retainedMessageCount: 2,
  });
  expect(cancelPendingE2eeDeliveries(pending, 2, 700)).toEqual(emptyE2eeTenantUsage());
});

test("fails closed on release underflow, unsafe integers, and malformed database usage", (): void => {
  expect((): E2eeTenantUsage => cancelPendingE2eeDeliveries(emptyE2eeTenantUsage(), 1, 1)).toThrow(
    "accounting invariant failed",
  );
  expect(
    (): E2eeTenantUsage =>
      applyE2eeUsageDelta(emptyE2eeTenantUsage(), {
        claimCount: Number.MAX_SAFE_INTEGER,
        pendingBroadcastCount: 0,
        pendingCiphertextBytes: 0,
        pendingDeliveryCount: 0,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: 0,
        retainedMessageCount: 0,
      }),
  ).toThrow();
  expect(
    (): E2eeTenantUsage =>
      applyE2eeUsageDelta(
        { ...emptyE2eeTenantUsage(), retainedCiphertextBytes: "corrupt" },
        emptyE2eeTenantUsage(),
      ),
  ).toThrow();
});
