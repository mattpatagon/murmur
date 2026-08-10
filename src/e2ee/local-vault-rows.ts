import { z } from "zod";

import type { AgentKeyCertificate, PrekeyCertificate } from "./certificates.js";
import type { PrekeyClass } from "./protocol.js";

const BytesSchema: z.ZodType<Uint8Array> = z
  .instanceof(Uint8Array)
  .transform((value: Uint8Array): Uint8Array => value.slice());
const SafeSqlIntegerSchema: z.ZodType<number> = z
  .union([z.number().int(), z.bigint()])
  .refine((value: number | bigint): boolean => Number.isSafeInteger(Number(value)), {
    message: "E2E vault integer exceeds JavaScript's safe range",
  })
  .transform((value: number | bigint): number => Number(value));

export type StoredRootKey = {
  readonly createdAt: string;
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly rootKeyId: string;
};

export type StoredAgentKey = {
  readonly certificate: AgentKeyCertificate;
  readonly privateKey: Uint8Array;
};

export type StoredPrekey = {
  readonly certificate: PrekeyCertificate;
  readonly consumedAt: string | null;
  readonly privateKey: Uint8Array | null;
};

export type PeerPin = {
  readonly agentId: string;
  readonly publicKey: Uint8Array;
  readonly rootKeyId: string;
  readonly tenantId: string;
  readonly verificationMode: "organization" | "strict" | "tofu";
  readonly verifiedAt: string;
};

export type OutboxItem = {
  readonly createdAt: string;
  readonly envelopeJson: string | null;
  readonly logicalId: string;
  readonly pairCounter: number;
  readonly plaintext: string;
  readonly plaintextDigest: Uint8Array;
  readonly recipientId: string;
  readonly senderId: string;
  readonly tenantId: string;
};

export type CachedMessage = {
  readonly expiresAt: string;
  readonly messageId: string;
  readonly pairCounter: number;
  readonly plaintext: string;
  readonly recipientId: string;
  readonly senderId: string;
  readonly tenantId: string;
};

type RootKeyRow = {
  readonly created_at: string;
  readonly private_key: Uint8Array;
  readonly public_key: Uint8Array;
  readonly root_key_id: string;
};

type AgentKeyRow = {
  readonly agent_id: string;
  readonly certificate_signature: Uint8Array;
  readonly created_at: string;
  readonly expires_at: string;
  readonly private_key: Uint8Array;
  readonly public_key: Uint8Array;
  readonly root_key_id: string;
  readonly signing_key_id: string;
};

type PrekeyRow = {
  readonly agent_id: string;
  readonly agent_signing_key_id: string;
  readonly certificate_signature: Uint8Array;
  readonly consumed_at: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly prekey_class: PrekeyClass;
  readonly prekey_id: string;
  readonly private_key: Uint8Array | null;
  readonly public_key: Uint8Array;
};

type PeerPinRow = {
  readonly agent_id: string;
  readonly public_key: Uint8Array;
  readonly root_key_id: string;
  readonly tenant_id: string;
  readonly verification_mode: "organization" | "strict" | "tofu";
  readonly verified_at: string;
};

type OutboxRow = {
  readonly created_at: string;
  readonly envelope_json: string | null;
  readonly logical_id: string;
  readonly pair_counter: number;
  readonly plaintext: string;
  readonly plaintext_digest: Uint8Array;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly tenant_id: string;
};

type CachedMessageRow = {
  readonly expires_at: string;
  readonly message_id: string;
  readonly pair_counter: number;
  readonly plaintext: string;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly tenant_id: string;
};

const RootKeyRowSchema: z.ZodType<RootKeyRow> = z.strictObject({
  created_at: z.string(),
  private_key: BytesSchema,
  public_key: BytesSchema,
  root_key_id: z.string(),
});
const AgentKeyRowSchema: z.ZodType<AgentKeyRow> = z.strictObject({
  agent_id: z.string(),
  certificate_signature: BytesSchema,
  created_at: z.string(),
  expires_at: z.string(),
  private_key: BytesSchema,
  public_key: BytesSchema,
  root_key_id: z.string(),
  signing_key_id: z.string(),
});
const PrekeyRowSchema: z.ZodType<PrekeyRow> = z.strictObject({
  agent_id: z.string(),
  agent_signing_key_id: z.string(),
  certificate_signature: BytesSchema,
  consumed_at: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  prekey_class: z.enum(["one_time", "fallback"]),
  prekey_id: z.string(),
  private_key: BytesSchema.nullable(),
  public_key: BytesSchema,
});

const PeerPinRowSchema: z.ZodType<PeerPinRow> = z.strictObject({
  agent_id: z.string(),
  public_key: BytesSchema,
  root_key_id: z.string(),
  tenant_id: z.string(),
  verification_mode: z.enum(["organization", "strict", "tofu"]),
  verified_at: z.string(),
});
const OutboxRowSchema: z.ZodType<OutboxRow> = z.strictObject({
  created_at: z.string(),
  envelope_json: z.string().nullable(),
  logical_id: z.string(),
  pair_counter: SafeSqlIntegerSchema,
  plaintext: z.string(),
  plaintext_digest: BytesSchema,
  recipient_id: z.string(),
  sender_id: z.string(),
  tenant_id: z.string(),
});
const CachedMessageRowSchema: z.ZodType<CachedMessageRow> = z.strictObject({
  expires_at: z.string(),
  message_id: z.string(),
  pair_counter: SafeSqlIntegerSchema,
  plaintext: z.string(),
  recipient_id: z.string(),
  sender_id: z.string(),
  tenant_id: z.string(),
});

export function mapRootKeyRow(input: unknown): StoredRootKey {
  const row: RootKeyRow = RootKeyRowSchema.parse(input);
  return {
    createdAt: row.created_at,
    privateKey: row.private_key,
    publicKey: row.public_key,
    rootKeyId: row.root_key_id,
  };
}

export function mapAgentKeyRow(input: unknown): StoredAgentKey {
  const row: AgentKeyRow = AgentKeyRowSchema.parse(input);
  return {
    certificate: {
      agentId: row.agent_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      rootKeyId: row.root_key_id,
      signature: row.certificate_signature,
      signingKeyId: row.signing_key_id,
      signingPublicKey: row.public_key,
    },
    privateKey: row.private_key,
  };
}

export function mapPrekeyRow(input: unknown): StoredPrekey {
  const row: PrekeyRow = PrekeyRowSchema.parse(input);
  return {
    certificate: {
      agentId: row.agent_id,
      agentSigningKeyId: row.agent_signing_key_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      prekeyClass: row.prekey_class,
      prekeyId: row.prekey_id,
      prekeyPublicKey: row.public_key,
      signature: row.certificate_signature,
    },
    consumedAt: row.consumed_at,
    privateKey: row.private_key,
  };
}

export function mapPeerPinRow(input: unknown): PeerPin {
  const row: PeerPinRow = PeerPinRowSchema.parse(input);
  return {
    agentId: row.agent_id,
    publicKey: row.public_key,
    rootKeyId: row.root_key_id,
    tenantId: row.tenant_id,
    verificationMode: row.verification_mode,
    verifiedAt: row.verified_at,
  };
}

export function mapOutboxRow(input: unknown): OutboxItem {
  const row: OutboxRow = OutboxRowSchema.parse(input);
  return {
    createdAt: row.created_at,
    envelopeJson: row.envelope_json,
    logicalId: row.logical_id,
    pairCounter: row.pair_counter,
    plaintext: row.plaintext,
    plaintextDigest: row.plaintext_digest,
    recipientId: row.recipient_id,
    senderId: row.sender_id,
    tenantId: row.tenant_id,
  };
}

export function safeSqlCount(input: unknown): number {
  return z.strictObject({ count: SafeSqlIntegerSchema }).parse(input).count;
}

export function mapCachedMessageRow(input: unknown): CachedMessage {
  const row: CachedMessageRow = CachedMessageRowSchema.parse(input);
  return {
    expiresAt: row.expires_at,
    messageId: row.message_id,
    pairCounter: row.pair_counter,
    plaintext: row.plaintext,
    recipientId: row.recipient_id,
    senderId: row.sender_id,
    tenantId: row.tenant_id,
  };
}
