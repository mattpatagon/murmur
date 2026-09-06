import { z } from "zod";

import { type AgentClientName, AgentClientNameSchema } from "../domain/client-provenance.js";
import type { AgentKeyCertificate, AgentKeyRevocation, PrekeyCertificate } from "./certificates.js";
import {
  E2EE_CIPHER_SUITE,
  E2EE_PADDING_SCHEME,
  E2EE_PROTOCOL,
  type EncryptedEnvelope,
  type EnvelopeHeader,
} from "./protocol.js";
import {
  type AgentKeyRevocationDto,
  AgentKeyRevocationDtoSchema,
  agentKeyRevocationToDto,
  revocationsFromDto,
  validateRevocationSet,
} from "./wire-revocations.js";

export type { AgentKeyRevocationDto } from "./wire-revocations.js";
export { AgentKeyRevocationDtoSchema, agentKeyRevocationToDto } from "./wire-revocations.js";

const KEY_BYTES: number = 32;
const SIGNATURE_BYTES: number = 64;
const NONCE_BYTES: number = 24;
export const MAX_E2EE_CIPHERTEXT_BYTES: number = 512 * 1024 + 16;
const Base64UrlSchema: z.ZodString = z
  .string()
  .min(1)
  .max(700_000)
  .regex(/^[A-Za-z0-9_-]+$/u);
const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RootKeyIdSchema: z.ZodString = z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u);
const AgentKeyIdSchema: z.ZodString = z.string().regex(/^mak_[A-Za-z0-9_-]{43}$/u);
const PrekeyIdSchema: z.ZodString = z.string().regex(/^mpk_[A-Za-z0-9_-]{43}$/u);
const UuidSchema: z.ZodString = z.string().uuid();
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const RepositoryNameSchema: z.ZodString = z
  .string()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u);

export type AgentKeyCertificateDto = {
  readonly agent_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly root_key_id: string;
  readonly signature: string;
  readonly signing_key_id: string;
  readonly signing_public_key: string;
};

export type PrekeyCertificateDto = {
  readonly agent_id: string;
  readonly agent_signing_key_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly prekey_class: "fallback" | "one_time";
  readonly prekey_id: string;
  readonly prekey_public_key: string;
  readonly signature: string;
};

export type PublicAgentKeyBundleDto = {
  readonly agent_certificate: AgentKeyCertificateDto;
  readonly agent_key_revocations?: readonly AgentKeyRevocationDto[] | undefined;
  readonly fallback_prekey: PrekeyCertificateDto;
  readonly one_time_prekeys: readonly PrekeyCertificateDto[];
  readonly root_key_id: string;
  readonly root_public_key: string;
};

export type PublicAgentKeyBundle = {
  readonly agentCertificate: AgentKeyCertificate;
  readonly agentKeyRevocations: readonly AgentKeyRevocation[];
  readonly fallbackPrekey: PrekeyCertificate;
  readonly oneTimePrekeys: readonly PrekeyCertificate[];
  readonly rootKeyId: string;
  readonly rootPublicKey: Uint8Array;
};

export type PublicAgentSigningChainDto = {
  readonly agent_certificate: AgentKeyCertificateDto;
  readonly agent_key_revocations?: readonly AgentKeyRevocationDto[] | undefined;
  readonly root_key_id: string;
  readonly root_public_key: string;
};

export type PublicAgentSigningChain = {
  readonly agentCertificate: AgentKeyCertificate;
  readonly agentKeyRevocations: readonly AgentKeyRevocation[];
  readonly rootKeyId: string;
  readonly rootPublicKey: Uint8Array;
};

export type EnvelopeHeaderDto = {
  readonly branch_name: string | null;
  readonly broadcast_id: string | null;
  readonly cipher_suite: typeof E2EE_CIPHER_SUITE;
  readonly client: AgentClientName | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_key: string;
  readonly message_id: string;
  readonly message_kind: "message" | "orchestration_request";
  readonly orchestrator_policy_id: string | null;
  readonly padded_length: number;
  readonly padding_scheme: typeof E2EE_PADDING_SCHEME;
  readonly pair_counter: number;
  readonly protocol: typeof E2EE_PROTOCOL;
  readonly recipient_agent_key_id: string;
  readonly recipient_id: string;
  readonly recipient_prekey_class: "fallback" | "one_time";
  readonly recipient_prekey_id: string;
  readonly recipient_root_key_id: string;
  readonly repository_name: string | null;
  readonly sender_agent_key_id: string;
  readonly sender_authority: "orchestrator" | "peer";
  readonly sender_id: string;
  readonly sender_root_key_id: string;
  readonly tenant_id: string;
  readonly thread_id: string;
};

export type EncryptedEnvelopeDto = {
  readonly ciphertext: string;
  readonly ephemeral_public_key: string;
  readonly header: EnvelopeHeaderDto;
  readonly nonce: string;
  readonly signature: string;
};

export const AgentKeyCertificateDtoSchema: z.ZodType<AgentKeyCertificateDto> = z.strictObject({
  agent_id: AgentIdSchema,
  created_at: InstantSchema,
  expires_at: InstantSchema,
  root_key_id: RootKeyIdSchema,
  signature: Base64UrlSchema.length(86),
  signing_key_id: AgentKeyIdSchema,
  signing_public_key: Base64UrlSchema.length(43),
});
export const PrekeyCertificateDtoSchema: z.ZodType<PrekeyCertificateDto> = z.strictObject({
  agent_id: AgentIdSchema,
  agent_signing_key_id: AgentKeyIdSchema,
  created_at: InstantSchema,
  expires_at: InstantSchema,
  prekey_class: z.enum(["fallback", "one_time"]),
  prekey_id: PrekeyIdSchema,
  prekey_public_key: Base64UrlSchema.length(43),
  signature: Base64UrlSchema.length(86),
});
export const PublicAgentKeyBundleDtoSchema: z.ZodType<PublicAgentKeyBundleDto> = z
  .strictObject({
    agent_certificate: AgentKeyCertificateDtoSchema,
    agent_key_revocations: z.array(AgentKeyRevocationDtoSchema).max(100).optional(),
    fallback_prekey: PrekeyCertificateDtoSchema,
    one_time_prekeys: z.array(PrekeyCertificateDtoSchema).max(100),
    root_key_id: RootKeyIdSchema,
    root_public_key: Base64UrlSchema.length(43),
  })
  .superRefine((bundle: PublicAgentKeyBundleDto, context: z.core.$RefinementCtx): void => {
    const agentId: string = bundle.agent_certificate.agent_id;
    const agentKeyId: string = bundle.agent_certificate.signing_key_id;
    const revocations: readonly AgentKeyRevocationDto[] =
      bundle.agent_key_revocations === undefined ? [] : bundle.agent_key_revocations;
    if (bundle.root_key_id !== bundle.agent_certificate.root_key_id) {
      context.addIssue({ code: "custom", message: "Bundle root identifiers do not match" });
    }
    const prekeys: readonly PrekeyCertificateDto[] = [
      bundle.fallback_prekey,
      ...bundle.one_time_prekeys,
    ];
    const seenPrekeyIds: Set<string> = new Set<string>();
    for (const prekey of prekeys) {
      if (prekey.agent_id !== agentId || prekey.agent_signing_key_id !== agentKeyId) {
        context.addIssue({ code: "custom", message: "Bundle prekey identity does not match" });
      }
      if (seenPrekeyIds.has(prekey.prekey_id)) {
        context.addIssue({ code: "custom", message: "Bundle prekey identifiers must be unique" });
      }
      seenPrekeyIds.add(prekey.prekey_id);
    }
    if (bundle.fallback_prekey.prekey_class !== "fallback") {
      context.addIssue({ code: "custom", message: "Bundle fallback prekey has the wrong class" });
    }
    if (
      bundle.one_time_prekeys.some(
        (prekey: PrekeyCertificateDto): boolean => prekey.prekey_class !== "one_time",
      )
    ) {
      context.addIssue({ code: "custom", message: "Bundle one-time prekey has the wrong class" });
    }
    validateRevocationSet(revocations, agentId, bundle.root_key_id, agentKeyId, context);
  });
export const PublicAgentSigningChainDtoSchema: z.ZodType<PublicAgentSigningChainDto> = z
  .strictObject({
    agent_certificate: AgentKeyCertificateDtoSchema,
    agent_key_revocations: z.array(AgentKeyRevocationDtoSchema).max(100).optional(),
    root_key_id: RootKeyIdSchema,
    root_public_key: Base64UrlSchema.length(43),
  })
  .superRefine((chain: PublicAgentSigningChainDto, context: z.core.$RefinementCtx): void => {
    if (chain.root_key_id !== chain.agent_certificate.root_key_id) {
      context.addIssue({ code: "custom", message: "Signing chain root identifiers do not match" });
    }
    const revocations: readonly AgentKeyRevocationDto[] =
      chain.agent_key_revocations === undefined ? [] : chain.agent_key_revocations;
    validateRevocationSet(
      revocations,
      chain.agent_certificate.agent_id,
      chain.root_key_id,
      chain.agent_certificate.signing_key_id,
      context,
    );
  });
const EnvelopeHeaderDtoSchema: z.ZodType<EnvelopeHeaderDto> = z
  .strictObject({
    branch_name: z.string().min(1).max(500).nullable(),
    broadcast_id: UuidSchema.nullable(),
    cipher_suite: z.literal(E2EE_CIPHER_SUITE),
    client: AgentClientNameSchema.nullable(),
    created_at: InstantSchema,
    expires_at: InstantSchema,
    idempotency_key: z.string().min(1).max(200),
    message_id: UuidSchema,
    message_kind: z.enum(["message", "orchestration_request"]),
    orchestrator_policy_id: UuidSchema.nullable(),
    padded_length: z
      .number()
      .int()
      .min(512)
      .max(512 * 1024)
      .refine((value: number): boolean => (value & (value - 1)) === 0),
    padding_scheme: z.literal(E2EE_PADDING_SCHEME),
    pair_counter: z.number().int().positive().safe(),
    protocol: z.literal(E2EE_PROTOCOL),
    recipient_agent_key_id: AgentKeyIdSchema,
    recipient_id: AgentIdSchema,
    recipient_prekey_class: z.enum(["fallback", "one_time"]),
    recipient_prekey_id: PrekeyIdSchema,
    recipient_root_key_id: RootKeyIdSchema,
    repository_name: RepositoryNameSchema.nullable(),
    sender_agent_key_id: AgentKeyIdSchema,
    sender_authority: z.enum(["orchestrator", "peer"]),
    sender_id: AgentIdSchema,
    sender_root_key_id: RootKeyIdSchema,
    tenant_id: UuidSchema,
    thread_id: z.string().min(1).max(200),
  })
  .superRefine((header: EnvelopeHeaderDto, context: z.core.$RefinementCtx): void => {
    const isOrchestration: boolean = header.message_kind === "orchestration_request";
    if (
      (isOrchestration && header.sender_authority !== "peer") ||
      isOrchestration !== (header.orchestrator_policy_id !== null)
    ) {
      context.addIssue({ code: "custom", message: "Envelope provenance is inconsistent" });
    }
  });
export const EncryptedEnvelopeDtoSchema: z.ZodType<EncryptedEnvelopeDto> = z.strictObject({
  ciphertext: Base64UrlSchema.max(700_000),
  ephemeral_public_key: Base64UrlSchema.length(43),
  header: EnvelopeHeaderDtoSchema,
  nonce: Base64UrlSchema.length(32),
  signature: Base64UrlSchema.length(86),
});

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

function headerToDto(header: EnvelopeHeader): EnvelopeHeaderDto {
  return {
    branch_name: header.branchName,
    broadcast_id: header.broadcastId,
    cipher_suite: header.cipherSuite,
    client: header.client,
    created_at: header.createdAt,
    expires_at: header.expiresAt,
    idempotency_key: header.idempotencyKey,
    message_id: header.messageId,
    message_kind: header.messageKind,
    orchestrator_policy_id: header.orchestratorPolicyId,
    padded_length: header.paddedLength,
    padding_scheme: header.paddingScheme,
    pair_counter: header.pairCounter,
    protocol: header.protocol,
    recipient_agent_key_id: header.recipientAgentKeyId,
    recipient_id: header.recipientId,
    recipient_prekey_class: header.recipientPrekeyClass,
    recipient_prekey_id: header.recipientPrekeyId,
    recipient_root_key_id: header.recipientRootKeyId,
    repository_name: header.repositoryName,
    sender_agent_key_id: header.senderAgentKeyId,
    sender_authority: header.senderAuthority,
    sender_id: header.senderId,
    sender_root_key_id: header.senderRootKeyId,
    tenant_id: header.tenantId,
    thread_id: header.threadId,
  };
}

function dtoToHeader(dto: EnvelopeHeaderDto): EnvelopeHeader {
  return {
    branchName: dto.branch_name,
    broadcastId: dto.broadcast_id,
    cipherSuite: dto.cipher_suite,
    client: dto.client,
    createdAt: dto.created_at,
    expiresAt: dto.expires_at,
    idempotencyKey: dto.idempotency_key,
    messageId: dto.message_id,
    messageKind: dto.message_kind,
    orchestratorPolicyId: dto.orchestrator_policy_id,
    paddedLength: dto.padded_length,
    paddingScheme: dto.padding_scheme,
    pairCounter: dto.pair_counter,
    protocol: dto.protocol,
    recipientAgentKeyId: dto.recipient_agent_key_id,
    recipientId: dto.recipient_id,
    recipientPrekeyClass: dto.recipient_prekey_class,
    recipientPrekeyId: dto.recipient_prekey_id,
    recipientRootKeyId: dto.recipient_root_key_id,
    repositoryName: dto.repository_name,
    senderAgentKeyId: dto.sender_agent_key_id,
    senderAuthority: dto.sender_authority,
    senderId: dto.sender_id,
    senderRootKeyId: dto.sender_root_key_id,
    tenantId: dto.tenant_id,
    threadId: dto.thread_id,
  };
}

export function envelopeToDto(envelope: EncryptedEnvelope): EncryptedEnvelopeDto {
  return {
    ciphertext: encodeBytes(envelope.ciphertext),
    ephemeral_public_key: encodeBytes(envelope.ephemeralPublicKey),
    header: headerToDto(envelope.header),
    nonce: encodeBytes(envelope.nonce),
    signature: encodeBytes(envelope.signature),
  };
}

export function parseEnvelopeDto(input: unknown): EncryptedEnvelope {
  const dto: EncryptedEnvelopeDto = EncryptedEnvelopeDtoSchema.parse(input);
  const ciphertext: Uint8Array = decodeBytes(
    dto.ciphertext,
    dto.header.padded_length + 16,
    "Ciphertext",
  );
  if (ciphertext.byteLength > MAX_E2EE_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext is too large");
  }
  return {
    ciphertext,
    ephemeralPublicKey: decodeBytes(dto.ephemeral_public_key, KEY_BYTES, "Ephemeral key"),
    header: dtoToHeader(dto.header),
    nonce: decodeBytes(dto.nonce, NONCE_BYTES, "Nonce"),
    signature: decodeBytes(dto.signature, SIGNATURE_BYTES, "Signature"),
  };
}

export function agentCertificateToDto(certificate: AgentKeyCertificate): AgentKeyCertificateDto {
  return {
    agent_id: certificate.agentId,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    root_key_id: certificate.rootKeyId,
    signature: encodeBytes(certificate.signature),
    signing_key_id: certificate.signingKeyId,
    signing_public_key: encodeBytes(certificate.signingPublicKey),
  };
}

export function prekeyCertificateToDto(certificate: PrekeyCertificate): PrekeyCertificateDto {
  return {
    agent_id: certificate.agentId,
    agent_signing_key_id: certificate.agentSigningKeyId,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    prekey_class: certificate.prekeyClass,
    prekey_id: certificate.prekeyId,
    prekey_public_key: encodeBytes(certificate.prekeyPublicKey),
    signature: encodeBytes(certificate.signature),
  };
}

function dtoToAgentCertificate(dto: AgentKeyCertificateDto): AgentKeyCertificate {
  return {
    agentId: dto.agent_id,
    createdAt: dto.created_at,
    expiresAt: dto.expires_at,
    rootKeyId: dto.root_key_id,
    signature: decodeBytes(dto.signature, SIGNATURE_BYTES, "Agent certificate signature"),
    signingKeyId: dto.signing_key_id,
    signingPublicKey: decodeBytes(dto.signing_public_key, KEY_BYTES, "Agent signing key"),
  };
}

function dtoToPrekeyCertificate(dto: PrekeyCertificateDto): PrekeyCertificate {
  return {
    agentId: dto.agent_id,
    agentSigningKeyId: dto.agent_signing_key_id,
    createdAt: dto.created_at,
    expiresAt: dto.expires_at,
    prekeyClass: dto.prekey_class,
    prekeyId: dto.prekey_id,
    prekeyPublicKey: decodeBytes(dto.prekey_public_key, KEY_BYTES, "Prekey public key"),
    signature: decodeBytes(dto.signature, SIGNATURE_BYTES, "Prekey signature"),
  };
}

export function publicBundleToDto(
  rootPublicKey: Uint8Array,
  agentCertificate: AgentKeyCertificate,
  fallbackPrekey: PrekeyCertificate,
  oneTimePrekeys: readonly PrekeyCertificate[],
  agentKeyRevocations: readonly AgentKeyRevocation[] = [],
): PublicAgentKeyBundleDto {
  return {
    agent_certificate: agentCertificateToDto(agentCertificate),
    agent_key_revocations: agentKeyRevocations.map(agentKeyRevocationToDto),
    fallback_prekey: prekeyCertificateToDto(fallbackPrekey),
    one_time_prekeys: oneTimePrekeys.map(prekeyCertificateToDto),
    root_key_id: agentCertificate.rootKeyId,
    root_public_key: encodeBytes(rootPublicKey),
  };
}

export function parsePublicBundleDto(input: unknown): PublicAgentKeyBundle {
  const dto: PublicAgentKeyBundleDto = PublicAgentKeyBundleDtoSchema.parse(input);
  return {
    agentCertificate: dtoToAgentCertificate(dto.agent_certificate),
    agentKeyRevocations: revocationsFromDto(dto.agent_key_revocations),
    fallbackPrekey: dtoToPrekeyCertificate(dto.fallback_prekey),
    oneTimePrekeys: dto.one_time_prekeys.map(dtoToPrekeyCertificate),
    rootKeyId: dto.root_key_id,
    rootPublicKey: decodeBytes(dto.root_public_key, KEY_BYTES, "Root public key"),
  };
}

export function signingChainToDto(
  rootPublicKey: Uint8Array,
  agentCertificate: AgentKeyCertificate,
  agentKeyRevocations: readonly AgentKeyRevocation[] = [],
): PublicAgentSigningChainDto {
  return {
    agent_certificate: agentCertificateToDto(agentCertificate),
    agent_key_revocations: agentKeyRevocations.map(agentKeyRevocationToDto),
    root_key_id: agentCertificate.rootKeyId,
    root_public_key: encodeBytes(rootPublicKey),
  };
}

export function parseSigningChainDto(input: unknown): PublicAgentSigningChain {
  const dto: PublicAgentSigningChainDto = PublicAgentSigningChainDtoSchema.parse(input);
  return {
    agentCertificate: dtoToAgentCertificate(dto.agent_certificate),
    agentKeyRevocations: revocationsFromDto(dto.agent_key_revocations),
    rootKeyId: dto.root_key_id,
    rootPublicKey: decodeBytes(dto.root_public_key, KEY_BYTES, "Root public key"),
  };
}

export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelopeToDto(envelope));
}

export function parseSerializedEnvelope(value: string): EncryptedEnvelope {
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error("Serialized encrypted envelope is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (_error: unknown) {
    throw new Error("Serialized encrypted envelope is invalid");
  }
  return parseEnvelopeDto(parsed);
}
