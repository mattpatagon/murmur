import { z } from "zod";

import type {
  LocalAgentKeyRevocation,
  LocalE2eeStatus,
  LocalPeerTrustSummary,
  LocalPrekeyReplenishment,
  LocalPublicIdentityExport,
} from "./local-commands.js";
import {
  AgentKeyCertificateDtoSchema,
  AgentKeyRevocationDtoSchema,
  PrekeyCertificateDtoSchema,
} from "./wire-contracts.js";

const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RootKeyIdSchema: z.ZodString = z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u);
const IssuerKeyIdSchema: z.ZodString = z.string().regex(/^mti_[A-Za-z0-9_-]{43}$/u);
const AgentKeyIdSchema: z.ZodString = z.string().regex(/^mak_[A-Za-z0-9_-]{43}$/u);
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });

export type LocalEmptyInput = Record<string, never>;
export type LocalAgentInput = { readonly agent_id: string };
export type LocalExportInput = LocalAgentInput & { readonly prekey_offset?: number | undefined };
export type LocalPublicExportOutput = LocalPublicIdentityExport & {
  readonly next_prekey_offset: number | null;
};
export type LocalPageInput = {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
};
export type LocalKeyChangeInput = LocalAgentInput & { readonly expected_agent_key_id: string };
export type LocalRevokeInput = LocalKeyChangeInput & { readonly reason: string };
export type LocalTrustInput = LocalAgentInput & { readonly root_key_id: string };
export type LocalTrustPolicyInput = {
  readonly policy_json: string;
  readonly issuer_key_id?: string | undefined;
};
export type LocalStatusOutput = LocalE2eeStatus & {
  readonly active_tenant_id: string | null;
  readonly active_tenant_bound_at: string | null;
};
export type LocalPeersOutput = {
  readonly peers: readonly LocalPeerTrustSummary[];
  readonly next_offset: number | null;
};
export type LocalTrustPolicyOutput = {
  readonly expires_at: string;
  readonly imported_at: string;
  readonly issuer_key_id: string;
  readonly tenant_id: string;
  readonly version: number;
};

export const LocalEmptyInputSchema: z.ZodType<LocalEmptyInput> = z.strictObject({});
export const LocalAgentInputSchema: z.ZodType<LocalAgentInput> = z.strictObject({
  agent_id: AgentIdSchema,
});
export const LocalExportInputSchema: z.ZodType<LocalExportInput> = z.strictObject({
  agent_id: AgentIdSchema,
  prekey_offset: z.number().int().nonnegative().safe().optional(),
});
export const LocalPageInputSchema: z.ZodType<LocalPageInput> = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(20_000).optional(),
});
export const LocalKeyChangeInputSchema: z.ZodType<LocalKeyChangeInput> = z.strictObject({
  agent_id: AgentIdSchema,
  expected_agent_key_id: AgentKeyIdSchema,
});
export const LocalRevokeInputSchema: z.ZodType<LocalRevokeInput> = z.strictObject({
  agent_id: AgentIdSchema,
  expected_agent_key_id: AgentKeyIdSchema,
  reason: z.string().min(1).max(500),
});
export const LocalTrustInputSchema: z.ZodType<LocalTrustInput> = z.strictObject({
  agent_id: AgentIdSchema,
  root_key_id: RootKeyIdSchema,
});
export const LocalTrustPolicyInputSchema: z.ZodType<LocalTrustPolicyInput> = z.strictObject({
  issuer_key_id: IssuerKeyIdSchema.optional(),
  policy_json: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
export const LocalStatusOutputSchema: z.ZodType<LocalStatusOutput> = z.strictObject({
  active_tenant_bound_at: InstantSchema.nullable(),
  active_tenant_id: z.string().uuid().nullable(),
  initialized: z.boolean(),
  peer_count: z.number().int().min(0).max(20_000),
  root_key_id: RootKeyIdSchema.nullable(),
});
export const LocalFingerprintOutputSchema: z.ZodType<{ readonly root_key_id: string }> =
  z.strictObject({ root_key_id: RootKeyIdSchema });
export const LocalPeerOutputSchema: z.ZodType<LocalPeerTrustSummary> = z.strictObject({
  agent_id: AgentIdSchema,
  root_key_id: RootKeyIdSchema,
  tenant_id: z.string().uuid(),
  verification: z.enum(["organization", "pending_strict", "strict", "tofu"]),
  verified_at: InstantSchema,
});
export const LocalPeersOutputSchema: z.ZodType<LocalPeersOutput> = z.strictObject({
  next_offset: z.number().int().min(1).max(20_000).nullable(),
  peers: z.array(LocalPeerOutputSchema).max(100),
});
export const LocalTrustPolicyOutputSchema: z.ZodType<LocalTrustPolicyOutput> = z.strictObject({
  expires_at: InstantSchema,
  imported_at: InstantSchema,
  issuer_key_id: IssuerKeyIdSchema,
  tenant_id: z.string().uuid(),
  version: z.number().int().positive().safe(),
});
export const LocalRevokeOutputSchema: z.ZodType<LocalAgentKeyRevocation> = z.strictObject({
  replacement_agent_certificate: AgentKeyCertificateDtoSchema,
  revocation: AgentKeyRevocationDtoSchema,
});
export const LocalReplenishOutputSchema: z.ZodType<LocalPrekeyReplenishment> = z.strictObject({
  agent_key_id: AgentKeyIdSchema,
  fallback_available: z.number().int().nonnegative().max(100),
  one_time_available: z.number().int().nonnegative().max(100),
});
export const LocalPublicExportOutputSchema: z.ZodType<LocalPublicExportOutput> = z.strictObject({
  agents: z
    .array(
      z.strictObject({
        agent_certificate: AgentKeyCertificateDtoSchema,
        agent_key_revocations: z.array(AgentKeyRevocationDtoSchema).max(100),
        prekeys: z.array(PrekeyCertificateDtoSchema).max(100),
      }),
    )
    .max(1),
  next_prekey_offset: z.number().int().positive().safe().nullable(),
  protocol: z.literal("murmur-e2ee-v1"),
  root_key_id: RootKeyIdSchema,
  root_public_key: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/u),
});
