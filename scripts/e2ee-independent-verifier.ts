import sodium from "libsodium-wrappers";
import { z } from "zod";

const OUTER_DOMAIN: string = "murmur-e2ee-v1/outer";
const SIGNATURE_DOMAIN: string = "murmur-e2ee-v1/signature";
const AGENT_CERTIFICATE_DOMAIN: string = "murmur-e2ee-v1/agent-certificate";
const PREKEY_CERTIFICATE_DOMAIN: string = "murmur-e2ee-v1/prekey-certificate";
const CIPHER_SUITE: "x25519-xsalsa20-poly1305+ed25519" =
  // biome-ignore lint/security/noSecrets: This is a public cipher-suite identifier, not credential material.
  "x25519-xsalsa20-poly1305+ed25519";
const NULL_LENGTH: number = 0xffff_ffff;
const MAX_FIELD_BYTES: number = 64 * 1024;
const PUBLIC_KEY_BYTES: number = 32;
const SIGNATURE_BYTES: number = 64;
const NONCE_BYTES: number = 24;
const encoder: TextEncoder = new TextEncoder();

type AgentCertificateDto = {
  readonly agent_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly root_key_id: string;
  readonly signature: string;
  readonly signing_key_id: string;
  readonly signing_public_key: string;
};

type PrekeyCertificateDto = {
  readonly agent_id: string;
  readonly agent_signing_key_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly prekey_class: "fallback" | "one_time";
  readonly prekey_id: string;
  readonly prekey_public_key: string;
  readonly signature: string;
};

type HeaderDto = {
  readonly branch_name: string | null;
  readonly broadcast_id: string | null;
  readonly cipher_suite: "x25519-xsalsa20-poly1305+ed25519";
  readonly client: "claude" | "codex" | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_key: string;
  readonly message_id: string;
  readonly message_kind: "message" | "orchestration_request";
  readonly orchestrator_policy_id: string | null;
  readonly padded_length: number;
  readonly padding_scheme: "power-of-two-v1";
  readonly pair_counter: number;
  readonly protocol: "murmur-e2ee-v1";
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

type EnvelopeDto = {
  readonly ciphertext: string;
  readonly ephemeral_public_key: string;
  readonly header: HeaderDto;
  readonly nonce: string;
  readonly signature: string;
};

type PublicChainDto = {
  readonly agent_certificate: AgentCertificateDto;
  readonly prekey_certificate?: PrekeyCertificateDto | undefined;
  readonly root_public_key: string;
};

export type CapturedEnvelopeInput = {
  readonly envelope: EnvelopeDto;
  readonly recipient: PublicChainDto;
  readonly sender: PublicChainDto;
};

export type IndependentVerification = {
  readonly message_id: string;
  readonly outer_header_blake2b_256: string;
  readonly protocol: "murmur-e2ee-v1";
  readonly recipient_root_key_id: string;
  readonly sender_root_key_id: string;
  readonly signature_verified: true;
};

export type IndependentHeaderDigest = {
  readonly byte_length: number;
  readonly outer_header_blake2b_256: string;
};

const Base64UrlSchema: z.ZodString = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RootKeyIdSchema: z.ZodString = z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u);
const AgentKeyIdSchema: z.ZodString = z.string().regex(/^mak_[A-Za-z0-9_-]{43}$/u);
const PrekeyIdSchema: z.ZodString = z.string().regex(/^mpk_[A-Za-z0-9_-]{43}$/u);
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const UuidSchema: z.ZodString = z.string().uuid();
const AgentCertificateSchema: z.ZodType<AgentCertificateDto> = z.strictObject({
  agent_id: AgentIdSchema,
  created_at: InstantSchema,
  expires_at: InstantSchema,
  root_key_id: RootKeyIdSchema,
  signature: Base64UrlSchema.length(86),
  signing_key_id: AgentKeyIdSchema,
  signing_public_key: Base64UrlSchema.length(43),
});
const PrekeyCertificateSchema: z.ZodType<PrekeyCertificateDto> = z.strictObject({
  agent_id: AgentIdSchema,
  agent_signing_key_id: AgentKeyIdSchema,
  created_at: InstantSchema,
  expires_at: InstantSchema,
  prekey_class: z.enum(["fallback", "one_time"]),
  prekey_id: PrekeyIdSchema,
  prekey_public_key: Base64UrlSchema.length(43),
  signature: Base64UrlSchema.length(86),
});
const HeaderSchema: z.ZodType<HeaderDto> = z.strictObject({
  branch_name: z.string().min(1).max(500).nullable(),
  broadcast_id: UuidSchema.nullable(),
  cipher_suite: z.literal(CIPHER_SUITE),
  client: z.enum(["claude", "codex"]).nullable(),
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
    .max(512 * 1024),
  padding_scheme: z.literal("power-of-two-v1"),
  pair_counter: z.number().int().positive().safe(),
  protocol: z.literal("murmur-e2ee-v1"),
  recipient_agent_key_id: AgentKeyIdSchema,
  recipient_id: AgentIdSchema,
  recipient_prekey_class: z.enum(["fallback", "one_time"]),
  recipient_prekey_id: PrekeyIdSchema,
  recipient_root_key_id: RootKeyIdSchema,
  repository_name: z
    .string()
    .min(3)
    .max(500)
    .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u)
    .nullable(),
  sender_agent_key_id: AgentKeyIdSchema,
  sender_authority: z.enum(["orchestrator", "peer"]),
  sender_id: AgentIdSchema,
  sender_root_key_id: RootKeyIdSchema,
  tenant_id: UuidSchema,
  thread_id: z.string().min(1).max(200),
});
const EnvelopeSchema: z.ZodType<EnvelopeDto> = z.strictObject({
  ciphertext: Base64UrlSchema.max(700_000),
  ephemeral_public_key: Base64UrlSchema.length(43),
  header: HeaderSchema,
  nonce: Base64UrlSchema.length(32),
  signature: Base64UrlSchema.length(86),
});
const PublicChainSchema: z.ZodType<PublicChainDto> = z.strictObject({
  agent_certificate: AgentCertificateSchema,
  prekey_certificate: PrekeyCertificateSchema.optional(),
  root_public_key: Base64UrlSchema.length(43),
});
const CapturedEnvelopeSchema: z.ZodType<CapturedEnvelopeInput> = z.strictObject({
  envelope: EnvelopeSchema,
  recipient: PublicChainSchema,
  sender: PublicChainSchema,
});

class IndependentWriter {
  readonly #chunks: Uint8Array[] = [];

  public bytes(value: Uint8Array): void {
    this.u32(value.byteLength);
    this.#chunks.push(value);
  }

  public nullable(value: string | null): void {
    if (value === null) {
      this.u32(NULL_LENGTH);
      return;
    }
    this.string(value);
  }

  public string(value: string): void {
    const encoded: Uint8Array = encoder.encode(value);
    if (encoded.byteLength > MAX_FIELD_BYTES) throw new Error("field limit");
    this.bytes(encoded);
  }

  public u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > NULL_LENGTH) throw new Error("u32");
    const encoded: Uint8Array = new Uint8Array(4);
    new DataView(encoded.buffer).setUint32(0, value, false);
    this.#chunks.push(encoded);
  }

  public u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("u64");
    const encoded: Uint8Array = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, BigInt(value), false);
    this.#chunks.push(encoded);
  }

  public finish(): Uint8Array {
    const length: number = this.#chunks.reduce(
      (total: number, chunk: Uint8Array): number => total + chunk.byteLength,
      0,
    );
    const output: Uint8Array = new Uint8Array(length);
    let offset: number = 0;
    for (const chunk of this.#chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

function decode(value: string, length: number): Uint8Array {
  const decoded: Uint8Array = Uint8Array.from(Buffer.from(value, "base64url"));
  if (decoded.byteLength !== length || Buffer.from(decoded).toString("base64url") !== value) {
    throw new Error("base64");
  }
  return decoded;
}

function keyId(prefix: "mak" | "mpk" | "mrk", publicKey: Uint8Array): string {
  const digest: Uint8Array = sodium.crypto_generichash(32, publicKey, null);
  const encoded: string = sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(digest);
  return `${prefix}_${encoded}`;
}

function encodeHeader(header: HeaderDto): Uint8Array {
  const writer: IndependentWriter = new IndependentWriter();
  writer.string(OUTER_DOMAIN);
  writer.string(header.protocol);
  writer.string(header.cipher_suite);
  writer.string(header.tenant_id);
  writer.string(header.message_id);
  writer.string(header.idempotency_key);
  writer.nullable(header.broadcast_id);
  writer.u64(header.pair_counter);
  writer.string(header.sender_id);
  writer.string(header.recipient_id);
  writer.string(header.thread_id);
  writer.nullable(header.repository_name);
  writer.nullable(header.branch_name);
  writer.nullable(header.client);
  writer.string(header.created_at);
  writer.string(header.expires_at);
  writer.string(header.sender_authority);
  writer.string(header.message_kind);
  writer.nullable(header.orchestrator_policy_id);
  writer.string(header.recipient_root_key_id);
  writer.string(header.recipient_agent_key_id);
  writer.string(header.recipient_prekey_id);
  writer.string(header.recipient_prekey_class);
  writer.string(header.sender_root_key_id);
  writer.string(header.sender_agent_key_id);
  writer.u32(header.padded_length);
  writer.string(header.padding_scheme);
  return writer.finish();
}

function encodeAgentCertificate(certificate: AgentCertificateDto): Uint8Array {
  const writer: IndependentWriter = new IndependentWriter();
  writer.string(AGENT_CERTIFICATE_DOMAIN);
  writer.string(certificate.root_key_id);
  writer.string(certificate.agent_id);
  writer.string(certificate.signing_key_id);
  writer.bytes(decode(certificate.signing_public_key, PUBLIC_KEY_BYTES));
  writer.string(certificate.created_at);
  writer.string(certificate.expires_at);
  return writer.finish();
}

function encodePrekeyCertificate(certificate: PrekeyCertificateDto): Uint8Array {
  const writer: IndependentWriter = new IndependentWriter();
  writer.string(PREKEY_CERTIFICATE_DOMAIN);
  writer.string(certificate.agent_id);
  writer.string(certificate.agent_signing_key_id);
  writer.string(certificate.prekey_id);
  writer.string(certificate.prekey_class);
  writer.bytes(decode(certificate.prekey_public_key, PUBLIC_KEY_BYTES));
  writer.string(certificate.created_at);
  writer.string(certificate.expires_at);
  return writer.finish();
}

function encodeSignature(
  outer: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const writer: IndependentWriter = new IndependentWriter();
  writer.string(SIGNATURE_DOMAIN);
  writer.bytes(outer);
  writer.bytes(ephemeralPublicKey);
  writer.bytes(nonce);
  writer.bytes(ciphertext);
  return writer.finish();
}

function checkWindow(createdAt: string, expiresAt: string, now: Date): void {
  const created: number = Date.parse(createdAt);
  const expires: number = Date.parse(expiresAt);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    expires <= created ||
    now.getTime() < created ||
    now.getTime() >= expires
  ) {
    throw new Error("window");
  }
}

function verifyAgentChain(chain: PublicChainDto, expectedAgentId: string, now: Date): Uint8Array {
  const root: Uint8Array = decode(chain.root_public_key, PUBLIC_KEY_BYTES);
  const certificate: AgentCertificateDto = chain.agent_certificate;
  const signingKey: Uint8Array = decode(certificate.signing_public_key, PUBLIC_KEY_BYTES);
  if (
    certificate.agent_id !== expectedAgentId ||
    certificate.root_key_id !== keyId("mrk", root) ||
    certificate.signing_key_id !== keyId("mak", signingKey)
  ) {
    throw new Error("agent identity");
  }
  checkWindow(certificate.created_at, certificate.expires_at, now);
  const canonical: Uint8Array = encodeAgentCertificate(certificate);
  const valid: boolean = sodium.crypto_sign_verify_detached(
    decode(certificate.signature, SIGNATURE_BYTES),
    canonical,
    root,
  );
  sodium.memzero(canonical);
  if (!valid) throw new Error("agent signature");
  return signingKey;
}

function verifyRecipientPrekey(
  chain: PublicChainDto,
  signingKey: Uint8Array,
  header: HeaderDto,
  now: Date,
): void {
  const certificate: PrekeyCertificateDto | undefined = chain.prekey_certificate;
  if (certificate === undefined) throw new Error("prekey missing");
  const publicKey: Uint8Array = decode(certificate.prekey_public_key, PUBLIC_KEY_BYTES);
  if (
    certificate.agent_id !== header.recipient_id ||
    certificate.agent_signing_key_id !== header.recipient_agent_key_id ||
    certificate.prekey_id !== header.recipient_prekey_id ||
    certificate.prekey_class !== header.recipient_prekey_class ||
    certificate.prekey_id !== keyId("mpk", publicKey)
  ) {
    throw new Error("prekey identity");
  }
  checkWindow(certificate.created_at, certificate.expires_at, now);
  const canonical: Uint8Array = encodePrekeyCertificate(certificate);
  const valid: boolean = sodium.crypto_sign_verify_detached(
    decode(certificate.signature, SIGNATURE_BYTES),
    canonical,
    signingKey,
  );
  sodium.memzero(canonical);
  if (!valid) throw new Error("prekey signature");
}

async function verify(input: unknown, now: Date): Promise<IndependentVerification> {
  await sodium.ready;
  const captured: CapturedEnvelopeInput = CapturedEnvelopeSchema.parse(input);
  const header: HeaderDto = captured.envelope.header;
  if ((header.padded_length & (header.padded_length - 1)) !== 0) throw new Error("padding");
  checkWindow(header.created_at, header.expires_at, now);
  const senderSigningKey: Uint8Array = verifyAgentChain(captured.sender, header.sender_id, now);
  const recipientSigningKey: Uint8Array = verifyAgentChain(
    captured.recipient,
    header.recipient_id,
    now,
  );
  if (
    header.sender_root_key_id !== captured.sender.agent_certificate.root_key_id ||
    header.sender_agent_key_id !== captured.sender.agent_certificate.signing_key_id ||
    header.recipient_root_key_id !== captured.recipient.agent_certificate.root_key_id ||
    header.recipient_agent_key_id !== captured.recipient.agent_certificate.signing_key_id
  ) {
    throw new Error("header chain");
  }
  verifyRecipientPrekey(captured.recipient, recipientSigningKey, header, now);
  const ciphertext: Uint8Array = decode(captured.envelope.ciphertext, header.padded_length + 16);
  const outer: Uint8Array = encodeHeader(header);
  const signatureInput: Uint8Array = encodeSignature(
    outer,
    decode(captured.envelope.ephemeral_public_key, PUBLIC_KEY_BYTES),
    decode(captured.envelope.nonce, NONCE_BYTES),
    ciphertext,
  );
  const valid: boolean = sodium.crypto_sign_verify_detached(
    decode(captured.envelope.signature, SIGNATURE_BYTES),
    signatureInput,
    senderSigningKey,
  );
  sodium.memzero(signatureInput);
  if (!valid) throw new Error("envelope signature");
  const digest: Uint8Array = sodium.crypto_generichash(32, outer, null);
  const digestHex: string = sodium.to_hex(digest);
  sodium.memzero(digest);
  return {
    message_id: header.message_id,
    outer_header_blake2b_256: digestHex,
    protocol: header.protocol,
    recipient_root_key_id: header.recipient_root_key_id,
    sender_root_key_id: header.sender_root_key_id,
    signature_verified: true,
  };
}

export async function verifyCapturedEnvelope(
  input: unknown,
  now: Date,
): Promise<IndependentVerification> {
  try {
    return await verify(input, now);
  } catch (_error: unknown) {
    throw new Error("Independent encrypted envelope verification failed");
  }
}

export async function digestCanonicalEnvelopeHeader(
  input: unknown,
): Promise<IndependentHeaderDigest> {
  await sodium.ready;
  const header: HeaderDto = HeaderSchema.parse(input);
  if ((header.padded_length & (header.padded_length - 1)) !== 0) {
    throw new Error("Independent envelope header has invalid padding");
  }
  const encoded: Uint8Array = encodeHeader(header);
  const digest: Uint8Array = sodium.crypto_generichash(32, encoded, null);
  const result: IndependentHeaderDigest = {
    byte_length: encoded.byteLength,
    outer_header_blake2b_256: sodium.to_hex(digest),
  };
  sodium.memzero(digest);
  return result;
}
