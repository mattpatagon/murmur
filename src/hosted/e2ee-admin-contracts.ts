import { z } from "zod";

import type { E2eeEntitlementRecord, E2eeTransitionAction } from "./e2ee-entitlement.js";

const EntitlementStateSchema: z.ZodType<E2eeEntitlementRecord["state"]> = z.enum([
  "off",
  "provisioning",
  "enforced",
]);
const E2eeTransitionActionSchema: z.ZodType<E2eeTransitionAction> = z.enum([
  "begin_provisioning",
  "block_plaintext_writes",
  "enforce",
  "rollback_off",
]);

export type E2eeEntitlementDto = {
  readonly plaintext_writes_blocked: boolean;
  readonly retained_ciphertext_messages: number;
  readonly state: E2eeEntitlementRecord["state"];
  readonly trust_policy_version: number | null;
  readonly unprovisioned_active_agents: number;
  readonly unread_plaintext_messages: number;
};

export type E2eeEntitlementOutput = Record<string, unknown> & {
  readonly entitlement: E2eeEntitlementDto;
};

export type TransitionE2eeInput = {
  readonly action: E2eeTransitionAction;
  readonly expected_state: E2eeEntitlementRecord["state"];
  readonly trust_policy_version?: number | undefined;
};

export type TransitionE2eeOutput = E2eeEntitlementOutput & {
  readonly changed: boolean;
};

export type ResetE2eeIdentityInput = {
  readonly agent_id: string;
  readonly expected_root_key_id: string;
  readonly reason: string;
};

export type ResetE2eeIdentityOutput = Record<string, unknown> & {
  readonly reset: boolean;
};

const E2eeEntitlementDtoSchema: z.ZodType<E2eeEntitlementDto> = z.strictObject({
  plaintext_writes_blocked: z.boolean(),
  retained_ciphertext_messages: z.number().int().nonnegative().safe(),
  state: EntitlementStateSchema,
  trust_policy_version: z.number().int().positive().safe().nullable(),
  unprovisioned_active_agents: z.number().int().nonnegative().safe(),
  unread_plaintext_messages: z.number().int().nonnegative().safe(),
});

export const GetE2eeEntitlementInputSchema: z.ZodType<Record<string, never>> = z.strictObject({});
export const E2eeEntitlementOutputSchema: z.ZodType<E2eeEntitlementOutput> = z.strictObject({
  entitlement: E2eeEntitlementDtoSchema,
});

export const TransitionE2eeInputSchema: z.ZodType<TransitionE2eeInput> = z
  .strictObject({
    action: E2eeTransitionActionSchema,
    expected_state: EntitlementStateSchema,
    trust_policy_version: z.number().int().positive().safe().optional(),
  })
  .superRefine((input: TransitionE2eeInput, context: z.core.$RefinementCtx): void => {
    if ((input.action === "enforce") !== (input.trust_policy_version !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only E2E enforcement requires a trust-policy version",
      });
    }
  });

export const TransitionE2eeOutputSchema: z.ZodType<TransitionE2eeOutput> = z.strictObject({
  changed: z.boolean(),
  entitlement: E2eeEntitlementDtoSchema,
});

export const ResetE2eeIdentityInputSchema: z.ZodType<ResetE2eeIdentityInput> = z.strictObject({
  agent_id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  expected_root_key_id: z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u),
  reason: z.string().trim().min(10).max(500),
});

export const ResetE2eeIdentityOutputSchema: z.ZodType<ResetE2eeIdentityOutput> = z.strictObject({
  reset: z.boolean(),
});

export function toE2eeEntitlementDto(record: E2eeEntitlementRecord): E2eeEntitlementDto {
  return {
    plaintext_writes_blocked: record.plaintextWritesBlocked,
    retained_ciphertext_messages: record.retainedCiphertextMessages,
    state: record.state,
    trust_policy_version: record.trustPolicyVersion,
    unprovisioned_active_agents: record.unprovisionedActiveAgents,
    unread_plaintext_messages: record.unreadPlaintextMessages,
  };
}
