import { RETENTION_DAYS } from "../domain/contracts.js";
import type {
  EncryptedEnvelopeDto,
  PublicAgentKeyBundleDto,
  PublicAgentSigningChainDto,
} from "../e2ee/wire-contracts.js";
import {
  EncryptedEnvelopeDtoSchema,
  PublicAgentKeyBundleDtoSchema,
  PublicAgentSigningChainDtoSchema,
} from "../e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
} from "../e2ee/wire-tools.js";
import type { PrekeyCertificateDto } from "../e2ee/wire-contracts.js";

const AUTH_TAG_BYTES: number = 16;

export type StoredEncryptionClaim = {
  readonly claim: ClaimEncryptionPrekeyOutput;
  readonly request: ClaimEncryptionPrekeyInput;
  readonly senderGeneration: number;
  readonly recipientGeneration: number;
};

function canonicalBase64UrlBytes(value: string, label: string): Uint8Array {
  const decoded: Uint8Array = Uint8Array.from(Buffer.from(value, "base64url"));
  if (Buffer.from(decoded).toString("base64url") !== value) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}

export function encryptedCiphertextBytes(envelopeInput: unknown): number {
  const envelope: EncryptedEnvelopeDto = EncryptedEnvelopeDtoSchema.parse(envelopeInput);
  const ciphertext: Uint8Array = canonicalBase64UrlBytes(
    envelope.ciphertext,
    "Encrypted ciphertext",
  );
  if (ciphertext.byteLength !== envelope.header.padded_length + AUTH_TAG_BYTES) {
    throw new Error("Encrypted ciphertext length does not match its signed header");
  }
  return ciphertext.byteLength;
}

export function senderChainFromBundle(bundleInput: unknown): PublicAgentSigningChainDto {
  const bundle: PublicAgentKeyBundleDto = PublicAgentKeyBundleDtoSchema.parse(bundleInput);
  return PublicAgentSigningChainDtoSchema.parse({
    agent_certificate: bundle.agent_certificate,
    root_key_id: bundle.root_key_id,
    root_public_key: bundle.root_public_key,
  });
}

export function e2eeEnvelopeJson(envelopeInput: unknown): string {
  return JSON.stringify(EncryptedEnvelopeDtoSchema.parse(envelopeInput));
}

export function validateEnvelopeForClaim(
  envelopeInput: unknown,
  stored: StoredEncryptionClaim,
  tenantId: string,
  broadcastId: string | null,
  nowIso: string,
): EncryptedEnvelopeDto {
  const envelope: EncryptedEnvelopeDto = EncryptedEnvelopeDtoSchema.parse(envelopeInput);
  encryptedCiphertextBytes(envelope);
  const header: EncryptedEnvelopeDto["header"] = envelope.header;
  const claim: ClaimEncryptionPrekeyOutput = stored.claim;
  const request: ClaimEncryptionPrekeyInput = stored.request;
  if (
    header.tenant_id !== tenantId ||
    header.sender_id !== request.sender_id ||
    header.recipient_id !== request.recipient_id ||
    header.repository_name !== request.context.repository ||
    header.branch_name !== request.context.branch ||
    header.client !== request.context.client ||
    header.broadcast_id !== broadcastId ||
    header.recipient_prekey_id !== claim.prekey_id ||
    header.recipient_prekey_class !== claim.prekey_class ||
    header.recipient_root_key_id !== claim.bundle.root_key_id ||
    header.recipient_agent_key_id !== claim.bundle.agent_certificate.signing_key_id ||
    header.message_kind !== claim.provenance.message_kind ||
    header.orchestrator_policy_id !== claim.provenance.orchestrator_policy_id ||
    header.sender_authority !== claim.provenance.sender_authority
  ) {
    throw new Error("Encrypted envelope does not match its server-issued claim");
  }
  const now: number = Date.parse(nowIso);
  const createdAt: number = Date.parse(header.created_at);
  const expiresAt: number = Date.parse(header.expires_at);
  const claimExpiresAt: number = Date.parse(claim.expires_at);
  const recipientCertificateExpiresAt: number = Date.parse(
    claim.bundle.agent_certificate.expires_at,
  );
  const selectedOneTimePrekey: PrekeyCertificateDto | undefined =
    claim.bundle.one_time_prekeys.find(
      (prekey: PrekeyCertificateDto): boolean => prekey.prekey_id === claim.prekey_id,
    );
  const selectedPrekeyExpiresAt: number = Date.parse(
    claim.prekey_class === "fallback"
      ? claim.bundle.fallback_prekey.expires_at
      : selectedOneTimePrekey === undefined
        ? ""
        : selectedOneTimePrekey.expires_at,
  );
  if (
    !Number.isFinite(now) ||
    createdAt > now ||
    expiresAt <= now ||
    claimExpiresAt <= now ||
    expiresAt > createdAt + RETENTION_DAYS * 24 * 60 * 60 * 1_000 ||
    expiresAt > recipientCertificateExpiresAt ||
    expiresAt > selectedPrekeyExpiresAt
  ) {
    throw new Error("Encrypted envelope key or retention window is invalid");
  }
  return envelope;
}
