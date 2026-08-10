import { z } from "zod";

const UsageValueSchema: z.ZodNumber = z.number().int().nonnegative().safe();
const UsageDeltaSchema: z.ZodNumber = z.number().int().safe();

export const DEFAULT_E2EE_QUOTAS: E2eeTenantQuotas = {
  maxClaimCount: 10_000,
  maxPendingBroadcastCount: 1_000,
  maxPendingCiphertextBytes: 64 * 1024 * 1024,
  maxPendingDeliveryCount: 10_000,
  maxPublicPrekeyCount: 100_000,
  maxRetainedCiphertextBytes: 256 * 1024 * 1024,
  maxRetainedMessageCount: 100_000,
};

export type E2eeTenantUsage = {
  readonly claimCount: number;
  readonly pendingBroadcastCount: number;
  readonly pendingCiphertextBytes: number;
  readonly pendingDeliveryCount: number;
  readonly publicPrekeyCount: number;
  readonly retainedCiphertextBytes: number;
  readonly retainedMessageCount: number;
};

export type E2eeTenantUsageDelta = E2eeTenantUsage;

export type E2eeTenantQuotas = {
  readonly maxClaimCount: number;
  readonly maxPendingBroadcastCount: number;
  readonly maxPendingCiphertextBytes: number;
  readonly maxPendingDeliveryCount: number;
  readonly maxPublicPrekeyCount: number;
  readonly maxRetainedCiphertextBytes: number;
  readonly maxRetainedMessageCount: number;
};

const E2eeTenantUsageSchema: z.ZodType<E2eeTenantUsage> = z.strictObject({
  claimCount: UsageValueSchema,
  pendingBroadcastCount: UsageValueSchema,
  pendingCiphertextBytes: UsageValueSchema,
  pendingDeliveryCount: UsageValueSchema,
  publicPrekeyCount: UsageValueSchema,
  retainedCiphertextBytes: UsageValueSchema,
  retainedMessageCount: UsageValueSchema,
});

const E2eeTenantUsageDeltaSchema: z.ZodType<E2eeTenantUsageDelta> = z.strictObject({
  claimCount: UsageDeltaSchema,
  pendingBroadcastCount: UsageDeltaSchema,
  pendingCiphertextBytes: UsageDeltaSchema,
  pendingDeliveryCount: UsageDeltaSchema,
  publicPrekeyCount: UsageDeltaSchema,
  retainedCiphertextBytes: UsageDeltaSchema,
  retainedMessageCount: UsageDeltaSchema,
});

const E2eeTenantQuotasSchema: z.ZodType<E2eeTenantQuotas> = z.strictObject({
  maxClaimCount: UsageValueSchema.positive(),
  maxPendingBroadcastCount: UsageValueSchema.positive(),
  maxPendingCiphertextBytes: UsageValueSchema.positive(),
  maxPendingDeliveryCount: UsageValueSchema.positive(),
  maxPublicPrekeyCount: UsageValueSchema.positive(),
  maxRetainedCiphertextBytes: UsageValueSchema.positive(),
  maxRetainedMessageCount: UsageValueSchema.positive(),
});

export function parseE2eeTenantUsage(input: unknown): E2eeTenantUsage {
  return E2eeTenantUsageSchema.parse(input);
}

export function emptyE2eeTenantUsage(): E2eeTenantUsage {
  return {
    claimCount: 0,
    pendingBroadcastCount: 0,
    pendingCiphertextBytes: 0,
    pendingDeliveryCount: 0,
    publicPrekeyCount: 0,
    retainedCiphertextBytes: 0,
    retainedMessageCount: 0,
  };
}

function checkedSum(current: number, delta: number): number {
  const sum: number = current + delta;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new Error("Tenant E2E usage accounting invariant failed");
  }
  return sum;
}

function enforceLimit(value: number, limit: number): void {
  if (value > limit) throw new Error("Tenant E2E resource quota exceeded");
}

export function applyE2eeUsageDelta(
  currentInput: unknown,
  deltaInput: unknown,
  quotaInput: unknown = DEFAULT_E2EE_QUOTAS,
): E2eeTenantUsage {
  const current: E2eeTenantUsage = E2eeTenantUsageSchema.parse(currentInput);
  const delta: E2eeTenantUsageDelta = E2eeTenantUsageDeltaSchema.parse(deltaInput);
  const quotas: E2eeTenantQuotas = E2eeTenantQuotasSchema.parse(quotaInput);
  const next: E2eeTenantUsage = {
    claimCount: checkedSum(current.claimCount, delta.claimCount),
    pendingBroadcastCount: checkedSum(current.pendingBroadcastCount, delta.pendingBroadcastCount),
    pendingCiphertextBytes: checkedSum(
      current.pendingCiphertextBytes,
      delta.pendingCiphertextBytes,
    ),
    pendingDeliveryCount: checkedSum(current.pendingDeliveryCount, delta.pendingDeliveryCount),
    publicPrekeyCount: checkedSum(current.publicPrekeyCount, delta.publicPrekeyCount),
    retainedCiphertextBytes: checkedSum(
      current.retainedCiphertextBytes,
      delta.retainedCiphertextBytes,
    ),
    retainedMessageCount: checkedSum(current.retainedMessageCount, delta.retainedMessageCount),
  };
  enforceLimit(next.claimCount, quotas.maxClaimCount);
  enforceLimit(next.pendingBroadcastCount, quotas.maxPendingBroadcastCount);
  enforceLimit(next.pendingCiphertextBytes, quotas.maxPendingCiphertextBytes);
  enforceLimit(next.pendingDeliveryCount, quotas.maxPendingDeliveryCount);
  enforceLimit(next.publicPrekeyCount, quotas.maxPublicPrekeyCount);
  enforceLimit(next.retainedCiphertextBytes, quotas.maxRetainedCiphertextBytes);
  enforceLimit(next.retainedMessageCount, quotas.maxRetainedMessageCount);
  return next;
}

export function commitPendingE2eeDeliveries(
  current: E2eeTenantUsage,
  deliveryCount: number,
  ciphertextBytes: number,
): E2eeTenantUsage {
  return applyE2eeUsageDelta(current, {
    claimCount: -deliveryCount,
    pendingBroadcastCount: -1,
    pendingCiphertextBytes: -ciphertextBytes,
    pendingDeliveryCount: -deliveryCount,
    publicPrekeyCount: 0,
    retainedCiphertextBytes: ciphertextBytes,
    retainedMessageCount: deliveryCount,
  });
}

export function cancelPendingE2eeDeliveries(
  current: E2eeTenantUsage,
  deliveryCount: number,
  ciphertextBytes: number,
): E2eeTenantUsage {
  return applyE2eeUsageDelta(current, {
    claimCount: -deliveryCount,
    pendingBroadcastCount: -1,
    pendingCiphertextBytes: -ciphertextBytes,
    pendingDeliveryCount: -deliveryCount,
    publicPrekeyCount: 0,
    retainedCiphertextBytes: 0,
    retainedMessageCount: 0,
  });
}
