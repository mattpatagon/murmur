import { z } from "zod";

import type { Instant } from "../domain/value-objects.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { StoredRootKey } from "./local-vault-rows.js";
import type { ActiveTenantBinding } from "./local-vault-settings.js";
import {
  createOrganizationTrustPolicy,
  type OrganizationTrustBinding,
  type OrganizationTrustBindingDto,
  OrganizationTrustBindingDtoSchema,
  type OrganizationTrustPolicy,
  type OrganizationTrustRevocation,
  type OrganizationTrustRevocationDto,
  OrganizationTrustRevocationDtoSchema,
  serializeTrustPolicy,
  trustIssuerKeyId,
  verifyOrganizationTrustPolicy,
} from "./trust-policy.js";

export type CreateLocalTrustPolicyInput = {
  readonly bindings: readonly OrganizationTrustBindingDto[];
  readonly revocations: readonly OrganizationTrustRevocationDto[];
  readonly validity_days: number;
  readonly version: number;
};
export type CreateLocalTrustPolicyOutput = {
  readonly issuer_key_id: string;
  readonly policy_json: string;
  readonly tenant_id: string;
  readonly version: number;
};

export const CreateLocalTrustPolicyInputSchema: z.ZodType<CreateLocalTrustPolicyInput> =
  z.strictObject({
    bindings: z.array(OrganizationTrustBindingDtoSchema).max(10_000),
    revocations: z.array(OrganizationTrustRevocationDtoSchema).max(10_000),
    validity_days: z.number().int().min(1).max(90),
    version: z.number().int().positive().safe(),
  });
export const CreateLocalTrustPolicyOutputSchema: z.ZodType<CreateLocalTrustPolicyOutput> =
  z.strictObject({
    issuer_key_id: z.string().regex(/^mti_[A-Za-z0-9_-]{43}$/u),
    policy_json: z
      .string()
      .min(1)
      .max(1024 * 1024),
    tenant_id: z.string().uuid(),
    version: z.number().int().positive().safe(),
  });

function bindingFromDto(binding: OrganizationTrustBindingDto): OrganizationTrustBinding {
  const publicKey: Uint8Array = Uint8Array.from(Buffer.from(binding.root_public_key, "base64url"));
  if (Buffer.from(publicKey).toString("base64url") !== binding.root_public_key) {
    throw new Error("Trusted root key is not canonical base64url");
  }
  return { agentId: binding.agent_id, rootKeyId: binding.root_key_id, rootPublicKey: publicKey };
}

export async function createLocalTrustPolicy(
  vault: LocalE2eeVault,
  input: CreateLocalTrustPolicyInput,
  now: Instant,
): Promise<CreateLocalTrustPolicyOutput> {
  const active: ActiveTenantBinding | null = vault.settings.getActiveTenant();
  if (active === null)
    throw new Error(
      "Bind the local encrypted endpoint to a tenant before creating its trust policy",
    );
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 1024 * 1024 - 2048) {
    throw new Error("Organization trust policy exceeds the 1 MiB serialized limit");
  }
  const root: StoredRootKey = await vault.keys.getOrCreateRoot(now.toISOString());
  const issuerKeyId: string = await trustIssuerKeyId(root.publicKey);
  // Trust statements and agent certificates use separate canonical signature domains.
  const policy: OrganizationTrustPolicy = await createOrganizationTrustPolicy(
    {
      bindings: input.bindings.map(bindingFromDto),
      createdAt: now.toISOString(),
      expiresAt: now.addDays(input.validity_days).toISOString(),
      issuerKeyId,
      issuerPublicKey: root.publicKey,
      revocations: input.revocations.map(
        (revocation: OrganizationTrustRevocationDto): OrganizationTrustRevocation => ({
          reason: revocation.reason,
          revokedAt: revocation.revoked_at,
          rootKeyId: revocation.root_key_id,
        }),
      ),
      tenantId: active.tenantId,
      version: input.version,
    },
    root.privateKey,
  );
  await verifyOrganizationTrustPolicy(policy, issuerKeyId, new Date(now.toISOString()));
  const serialized: string = serializeTrustPolicy(policy);
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw new Error("Organization trust policy exceeds the 1 MiB serialized limit");
  }
  return {
    issuer_key_id: issuerKeyId,
    policy_json: serialized,
    tenant_id: active.tenantId,
    version: input.version,
  };
}
