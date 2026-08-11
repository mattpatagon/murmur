import sodium from "libsodium-wrappers";
import { z } from "zod";

import { rootKeyId } from "./certificates.js";
import { BinaryWriter } from "./encoding.js";

export const ORGANIZATION_TRUST_POLICY_PROTOCOL: "murmur-trust-policy-v1" =
  "murmur-trust-policy-v1";

const TRUST_POLICY_DOMAIN: string = "murmur-e2ee-v1/organization-trust-policy";
const PUBLIC_KEY_BYTES: number = 32;
const PRIVATE_KEY_BYTES: number = 64;
const SIGNATURE_BYTES: number = 64;
const FINGERPRINT_BYTES: number = 32;
const MAX_TRUST_FILE_BYTES: number = 1024 * 1024;
const Base64UrlSchema: z.ZodString = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RootKeyIdSchema: z.ZodString = z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u);
const IssuerKeyIdSchema: z.ZodString = z.string().regex(/^mti_[A-Za-z0-9_-]{43}$/u);
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });

export type OrganizationTrustBindingDto = {
  readonly agent_id: string;
  readonly root_key_id: string;
  readonly root_public_key: string;
};

export type OrganizationTrustRevocationDto = {
  readonly reason: string;
  readonly revoked_at: string;
  readonly root_key_id: string;
};

export type OrganizationTrustPolicyDto = {
  readonly bindings: readonly OrganizationTrustBindingDto[];
  readonly created_at: string;
  readonly expires_at: string;
  readonly issuer_key_id: string;
  readonly issuer_public_key: string;
  readonly protocol: typeof ORGANIZATION_TRUST_POLICY_PROTOCOL;
  readonly revocations: readonly OrganizationTrustRevocationDto[];
  readonly signature: string;
  readonly tenant_id: string;
  readonly version: number;
};

export type OrganizationTrustBinding = {
  readonly agentId: string;
  readonly rootKeyId: string;
  readonly rootPublicKey: Uint8Array;
};

export type OrganizationTrustRevocation = {
  readonly reason: string;
  readonly revokedAt: string;
  readonly rootKeyId: string;
};

export type OrganizationTrustPolicyFields = {
  readonly bindings: readonly OrganizationTrustBinding[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly issuerKeyId: string;
  readonly issuerPublicKey: Uint8Array;
  readonly revocations: readonly OrganizationTrustRevocation[];
  readonly tenantId: string;
  readonly version: number;
};

export type OrganizationTrustPolicy = OrganizationTrustPolicyFields & {
  readonly signature: Uint8Array;
};

const OrganizationTrustBindingDtoSchema: z.ZodType<OrganizationTrustBindingDto> = z.strictObject({
  agent_id: AgentIdSchema,
  root_key_id: RootKeyIdSchema,
  root_public_key: Base64UrlSchema.length(43),
});
const OrganizationTrustRevocationDtoSchema: z.ZodType<OrganizationTrustRevocationDto> =
  z.strictObject({
    reason: z.string().min(1).max(500),
    revoked_at: InstantSchema,
    root_key_id: RootKeyIdSchema,
  });
export const OrganizationTrustPolicyDtoSchema: z.ZodType<OrganizationTrustPolicyDto> = z
  .strictObject({
    bindings: z.array(OrganizationTrustBindingDtoSchema).max(10_000),
    created_at: InstantSchema,
    expires_at: InstantSchema,
    issuer_key_id: IssuerKeyIdSchema,
    issuer_public_key: Base64UrlSchema.length(43),
    protocol: z.literal(ORGANIZATION_TRUST_POLICY_PROTOCOL),
    revocations: z.array(OrganizationTrustRevocationDtoSchema).max(10_000),
    signature: Base64UrlSchema.length(86),
    tenant_id: z.string().uuid(),
    version: z.number().int().positive().safe(),
  })
  .superRefine((policy: OrganizationTrustPolicyDto, context: z.core.$RefinementCtx): void => {
    requireSortedUnique(
      policy.bindings.map((binding: OrganizationTrustBindingDto): string => binding.agent_id),
      "bindings",
      context,
    );
    const revokedIds: readonly string[] = policy.revocations.map(
      (revocation: OrganizationTrustRevocationDto): string => revocation.root_key_id,
    );
    requireSortedUnique(revokedIds, "revocations", context);
    const revoked: ReadonlySet<string> = new Set<string>(revokedIds);
    if (
      policy.bindings.some((binding: OrganizationTrustBindingDto): boolean =>
        revoked.has(binding.root_key_id),
      )
    ) {
      context.addIssue({ code: "custom", message: "Trust policy binds a revoked root" });
    }
  });

function requireSortedUnique(
  values: readonly string[],
  label: string,
  context: z.core.$RefinementCtx,
): void {
  for (let index: number = 1; index < values.length; index += 1) {
    const previous: string | undefined = values[index - 1];
    const current: string | undefined = values[index];
    if (previous === undefined || current === undefined) continue;
    if (previous >= current) {
      context.addIssue({
        code: "custom",
        message: `Trust policy ${label} must be sorted and unique`,
      });
      return;
    }
  }
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBytes(value: string, expectedLength: number, label: string): Uint8Array {
  const decoded: Uint8Array = Uint8Array.from(Buffer.from(value, "base64url"));
  if (decoded.byteLength !== expectedLength || encodeBytes(decoded) !== value) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}

function sortedFields(fields: OrganizationTrustPolicyFields): OrganizationTrustPolicyFields {
  return {
    ...fields,
    bindings: [...fields.bindings].sort(
      (left: OrganizationTrustBinding, right: OrganizationTrustBinding): number =>
        left.agentId.localeCompare(right.agentId),
    ),
    revocations: [...fields.revocations].sort(
      (left: OrganizationTrustRevocation, right: OrganizationTrustRevocation): number =>
        left.rootKeyId.localeCompare(right.rootKeyId),
    ),
  };
}

function canonicalPolicyFields(fields: OrganizationTrustPolicyFields): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(TRUST_POLICY_DOMAIN);
  writer.writeString(fields.tenantId);
  writer.writeString(fields.issuerKeyId);
  writer.writeBytes(fields.issuerPublicKey);
  writer.writeU64(fields.version);
  writer.writeString(fields.createdAt);
  writer.writeString(fields.expiresAt);
  writer.writeU32(fields.bindings.length);
  for (const binding of fields.bindings) {
    writer.writeString(binding.agentId);
    writer.writeString(binding.rootKeyId);
    writer.writeBytes(binding.rootPublicKey);
  }
  writer.writeU32(fields.revocations.length);
  for (const revocation of fields.revocations) {
    writer.writeString(revocation.rootKeyId);
    writer.writeString(revocation.revokedAt);
    writer.writeString(revocation.reason);
  }
  return writer.finish();
}

function requireValidity(policy: OrganizationTrustPolicy, now: Date): void {
  const createdMillis: number = Date.parse(policy.createdAt);
  const expiresMillis: number = Date.parse(policy.expiresAt);
  const nowMillis: number = now.getTime();
  if (
    !Number.isFinite(createdMillis) ||
    !Number.isFinite(expiresMillis) ||
    expiresMillis <= createdMillis ||
    nowMillis < createdMillis ||
    nowMillis >= expiresMillis
  ) {
    throw new Error("Organization trust policy is outside its validity window");
  }
}

export async function trustIssuerKeyId(publicKey: Uint8Array): Promise<string> {
  await sodium.ready;
  if (publicKey.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error("Trust issuer public key has an invalid length");
  }
  const digest: Uint8Array = sodium.crypto_generichash(FINGERPRINT_BYTES, publicKey, null);
  const encoded: string = sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(digest);
  return `mti_${encoded}`;
}

export async function createOrganizationTrustPolicy(
  fields: OrganizationTrustPolicyFields,
  issuerPrivateKey: Uint8Array,
): Promise<OrganizationTrustPolicy> {
  await sodium.ready;
  if (issuerPrivateKey.byteLength !== PRIVATE_KEY_BYTES) {
    throw new Error("Trust issuer private key has an invalid length");
  }
  const ordered: OrganizationTrustPolicyFields = sortedFields(fields);
  const canonical: Uint8Array = canonicalPolicyFields(ordered);
  try {
    return {
      ...ordered,
      signature: sodium.crypto_sign_detached(canonical, issuerPrivateKey),
    };
  } finally {
    sodium.memzero(canonical);
  }
}

export async function verifyOrganizationTrustPolicy(
  policy: OrganizationTrustPolicy,
  expectedIssuerKeyId: string,
  now: Date,
): Promise<void> {
  await sodium.ready;
  OrganizationTrustPolicyDtoSchema.parse(trustPolicyToDto(policy));
  if (policy.issuerPublicKey.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error("Trust issuer public key has an invalid length");
  }
  if (policy.signature.byteLength !== SIGNATURE_BYTES) {
    throw new Error("Organization trust policy signature has an invalid length");
  }
  const derivedIssuerId: string = await trustIssuerKeyId(policy.issuerPublicKey);
  if (policy.issuerKeyId !== derivedIssuerId || policy.issuerKeyId !== expectedIssuerKeyId) {
    throw new Error("Organization trust issuer fingerprint mismatch");
  }
  for (const binding of policy.bindings) {
    if (binding.rootPublicKey.byteLength !== PUBLIC_KEY_BYTES) {
      throw new Error("Trusted root public key has an invalid length");
    }
    if (binding.rootKeyId !== (await rootKeyId(binding.rootPublicKey))) {
      throw new Error("Trusted root fingerprint mismatch");
    }
  }
  requireValidity(policy, now);
  const canonical: Uint8Array = canonicalPolicyFields(policy);
  const valid: boolean = sodium.crypto_sign_verify_detached(
    policy.signature,
    canonical,
    policy.issuerPublicKey,
  );
  sodium.memzero(canonical);
  if (!valid) throw new Error("Organization trust policy signature is invalid");
}

export function trustPolicyToDto(policy: OrganizationTrustPolicy): OrganizationTrustPolicyDto {
  return {
    bindings: policy.bindings.map(
      (binding: OrganizationTrustBinding): OrganizationTrustBindingDto => ({
        agent_id: binding.agentId,
        root_key_id: binding.rootKeyId,
        root_public_key: encodeBytes(binding.rootPublicKey),
      }),
    ),
    created_at: policy.createdAt,
    expires_at: policy.expiresAt,
    issuer_key_id: policy.issuerKeyId,
    issuer_public_key: encodeBytes(policy.issuerPublicKey),
    protocol: ORGANIZATION_TRUST_POLICY_PROTOCOL,
    revocations: policy.revocations.map(
      (revocation: OrganizationTrustRevocation): OrganizationTrustRevocationDto => ({
        reason: revocation.reason,
        revoked_at: revocation.revokedAt,
        root_key_id: revocation.rootKeyId,
      }),
    ),
    signature: encodeBytes(policy.signature),
    tenant_id: policy.tenantId,
    version: policy.version,
  };
}

export function parseOrganizationTrustPolicy(input: unknown): OrganizationTrustPolicy {
  const dto: OrganizationTrustPolicyDto = OrganizationTrustPolicyDtoSchema.parse(input);
  return {
    bindings: dto.bindings.map(
      (binding: OrganizationTrustBindingDto): OrganizationTrustBinding => ({
        agentId: binding.agent_id,
        rootKeyId: binding.root_key_id,
        rootPublicKey: decodeBytes(binding.root_public_key, PUBLIC_KEY_BYTES, "Trusted root key"),
      }),
    ),
    createdAt: dto.created_at,
    expiresAt: dto.expires_at,
    issuerKeyId: dto.issuer_key_id,
    issuerPublicKey: decodeBytes(dto.issuer_public_key, PUBLIC_KEY_BYTES, "Trust issuer key"),
    revocations: dto.revocations.map(
      (revocation: OrganizationTrustRevocationDto): OrganizationTrustRevocation => ({
        reason: revocation.reason,
        revokedAt: revocation.revoked_at,
        rootKeyId: revocation.root_key_id,
      }),
    ),
    signature: decodeBytes(dto.signature, SIGNATURE_BYTES, "Trust policy signature"),
    tenantId: dto.tenant_id,
    version: dto.version,
  };
}

export function serializeTrustPolicy(policy: OrganizationTrustPolicy): string {
  return JSON.stringify(trustPolicyToDto(policy));
}

export function parseSerializedTrustPolicy(value: string): OrganizationTrustPolicy {
  if (Buffer.byteLength(value, "utf8") > MAX_TRUST_FILE_BYTES) {
    throw new Error("Organization trust file is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (_error: unknown) {
    throw new Error("Organization trust file is invalid");
  }
  return parseOrganizationTrustPolicy(parsed);
}
