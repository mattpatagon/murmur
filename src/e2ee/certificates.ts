import sodium from "libsodium-wrappers";

import { BinaryWriter } from "./encoding.js";
import type { BoxKeyPair, PrekeyClass, SigningKeyPair } from "./protocol.js";

const AGENT_CERTIFICATE_DOMAIN: string = "murmur-e2ee-v1/agent-certificate";
const AGENT_KEY_REVOCATION_DOMAIN: string = "murmur-e2ee-v1/agent-key-revocation";
const PREKEY_CERTIFICATE_DOMAIN: string = "murmur-e2ee-v1/prekey-certificate";
const FINGERPRINT_BYTES: number = 32;

export type AgentKeyCertificateFields = {
  readonly agentId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rootKeyId: string;
  readonly signingKeyId: string;
  readonly signingPublicKey: Uint8Array;
};

export type AgentKeyCertificate = AgentKeyCertificateFields & {
  readonly signature: Uint8Array;
};

export type AgentKeyRevocationFields = {
  readonly agentId: string;
  readonly reason: string;
  readonly revokedAt: string;
  readonly revokedSigningKeyId: string;
  readonly rootKeyId: string;
};

export type AgentKeyRevocation = AgentKeyRevocationFields & {
  readonly signature: Uint8Array;
};

export type PrekeyCertificateFields = {
  readonly agentId: string;
  readonly agentSigningKeyId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly prekeyClass: PrekeyClass;
  readonly prekeyId: string;
  readonly prekeyPublicKey: Uint8Array;
};

export type PrekeyCertificate = PrekeyCertificateFields & {
  readonly signature: Uint8Array;
};

function requireLength(value: Uint8Array, length: number, label: string): void {
  if (value.byteLength !== length) throw new Error(`${label} has an invalid length`);
}

function validateWindow(createdAt: string, expiresAt: string, now: Date): void {
  const createdMillis: number = Date.parse(createdAt);
  const expiresMillis: number = Date.parse(expiresAt);
  const nowMillis: number = now.getTime();
  if (!Number.isFinite(createdMillis) || !Number.isFinite(expiresMillis)) {
    throw new Error("Key certificate has an invalid timestamp");
  }
  if (expiresMillis <= createdMillis || nowMillis < createdMillis || nowMillis >= expiresMillis) {
    throw new Error("Key certificate is outside its validity window");
  }
}

function encodeAgentCertificateFields(fields: AgentKeyCertificateFields): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(AGENT_CERTIFICATE_DOMAIN);
  writer.writeString(fields.rootKeyId);
  writer.writeString(fields.agentId);
  writer.writeString(fields.signingKeyId);
  writer.writeBytes(fields.signingPublicKey);
  writer.writeString(fields.createdAt);
  writer.writeString(fields.expiresAt);
  return writer.finish();
}

function encodeAgentKeyRevocationFields(fields: AgentKeyRevocationFields): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(AGENT_KEY_REVOCATION_DOMAIN);
  writer.writeString(fields.rootKeyId);
  writer.writeString(fields.agentId);
  writer.writeString(fields.revokedSigningKeyId);
  writer.writeString(fields.revokedAt);
  writer.writeString(fields.reason);
  return writer.finish();
}

function encodePrekeyCertificateFields(fields: PrekeyCertificateFields): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(PREKEY_CERTIFICATE_DOMAIN);
  writer.writeString(fields.agentId);
  writer.writeString(fields.agentSigningKeyId);
  writer.writeString(fields.prekeyId);
  writer.writeString(fields.prekeyClass);
  writer.writeBytes(fields.prekeyPublicKey);
  writer.writeString(fields.createdAt);
  writer.writeString(fields.expiresAt);
  return writer.finish();
}

function keyId(prefix: string, publicKey: Uint8Array): string {
  const digest: Uint8Array = sodium.crypto_generichash(FINGERPRINT_BYTES, publicKey, null);
  const encoded: string = sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(digest);
  return `${prefix}_${encoded}`;
}

export async function rootKeyId(publicKey: Uint8Array): Promise<string> {
  await sodium.ready;
  requireLength(publicKey, sodium.crypto_sign_PUBLICKEYBYTES, "Root public key");
  return keyId("mrk", publicKey);
}

export async function agentSigningKeyId(publicKey: Uint8Array): Promise<string> {
  await sodium.ready;
  requireLength(publicKey, sodium.crypto_sign_PUBLICKEYBYTES, "Agent public key");
  return keyId("mak", publicKey);
}

export async function prekeyId(publicKey: Uint8Array): Promise<string> {
  await sodium.ready;
  requireLength(publicKey, sodium.crypto_box_PUBLICKEYBYTES, "Prekey public key");
  return keyId("mpk", publicKey);
}

export async function createSigningKeyPair(seed: Uint8Array | null): Promise<SigningKeyPair> {
  await sodium.ready;
  if (seed === null) {
    const pair: { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string } =
      sodium.crypto_sign_keypair();
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  }
  requireLength(seed, sodium.crypto_sign_SEEDBYTES, "Signing seed");
  const seedCopy: Uint8Array = seed.slice();
  try {
    const pair: { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string } =
      sodium.crypto_sign_seed_keypair(seedCopy);
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  } finally {
    sodium.memzero(seedCopy);
  }
}

export async function createBoxKeyPair(seed: Uint8Array | null): Promise<BoxKeyPair> {
  await sodium.ready;
  if (seed === null) {
    const pair: { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string } =
      sodium.crypto_box_keypair();
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  }
  requireLength(seed, sodium.crypto_box_SEEDBYTES, "Box seed");
  const seedCopy: Uint8Array = seed.slice();
  try {
    const pair: { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string } =
      sodium.crypto_box_seed_keypair(seedCopy);
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  } finally {
    sodium.memzero(seedCopy);
  }
}

export async function createAgentKeyCertificate(
  fields: AgentKeyCertificateFields,
  rootPrivateKey: Uint8Array,
): Promise<AgentKeyCertificate> {
  await sodium.ready;
  requireLength(rootPrivateKey, sodium.crypto_sign_SECRETKEYBYTES, "Root private key");
  const canonical: Uint8Array = encodeAgentCertificateFields(fields);
  const signature: Uint8Array = sodium.crypto_sign_detached(canonical, rootPrivateKey);
  sodium.memzero(canonical);
  return { ...fields, signature };
}

export async function verifyAgentKeyCertificate(
  certificate: AgentKeyCertificate,
  rootPublicKey: Uint8Array,
  expectedAgentId: string,
  now: Date,
): Promise<void> {
  await sodium.ready;
  requireLength(rootPublicKey, sodium.crypto_sign_PUBLICKEYBYTES, "Root public key");
  requireLength(
    certificate.signingPublicKey,
    sodium.crypto_sign_PUBLICKEYBYTES,
    "Agent public key",
  );
  requireLength(certificate.signature, sodium.crypto_sign_BYTES, "Agent certificate signature");
  if (certificate.agentId !== expectedAgentId)
    throw new Error("Agent certificate identity mismatch");
  if (certificate.rootKeyId !== keyId("mrk", rootPublicKey)) {
    throw new Error("Agent certificate root mismatch");
  }
  if (certificate.signingKeyId !== keyId("mak", certificate.signingPublicKey)) {
    throw new Error("Agent certificate signing key mismatch");
  }
  validateWindow(certificate.createdAt, certificate.expiresAt, now);
  const canonical: Uint8Array = encodeAgentCertificateFields(certificate);
  const valid: boolean = sodium.crypto_sign_verify_detached(
    certificate.signature,
    canonical,
    rootPublicKey,
  );
  sodium.memzero(canonical);
  if (!valid) throw new Error("Agent certificate signature is invalid");
}

export async function createAgentKeyRevocation(
  fields: AgentKeyRevocationFields,
  rootPrivateKey: Uint8Array,
): Promise<AgentKeyRevocation> {
  await sodium.ready;
  requireLength(rootPrivateKey, sodium.crypto_sign_SECRETKEYBYTES, "Root private key");
  const canonical: Uint8Array = encodeAgentKeyRevocationFields(fields);
  const signature: Uint8Array = sodium.crypto_sign_detached(canonical, rootPrivateKey);
  sodium.memzero(canonical);
  return { ...fields, signature };
}

export async function verifyAgentKeyRevocation(
  revocation: AgentKeyRevocation,
  rootPublicKey: Uint8Array,
  expectedAgentId: string,
  now: Date,
): Promise<void> {
  await sodium.ready;
  requireLength(rootPublicKey, sodium.crypto_sign_PUBLICKEYBYTES, "Root public key");
  requireLength(revocation.signature, sodium.crypto_sign_BYTES, "Agent revocation signature");
  if (revocation.agentId !== expectedAgentId) throw new Error("Agent revocation identity mismatch");
  if (revocation.rootKeyId !== keyId("mrk", rootPublicKey)) {
    throw new Error("Agent revocation root mismatch");
  }
  if (!/^mak_[A-Za-z0-9_-]{43}$/u.test(revocation.revokedSigningKeyId)) {
    throw new Error("Agent revocation signing key is invalid");
  }
  const revokedAt: number = Date.parse(revocation.revokedAt);
  if (!Number.isFinite(revokedAt) || revokedAt > now.getTime()) {
    throw new Error("Agent revocation time is invalid");
  }
  if (revocation.reason.length < 1 || revocation.reason.length > 500) {
    throw new Error("Agent revocation reason is invalid");
  }
  const canonical: Uint8Array = encodeAgentKeyRevocationFields(revocation);
  const valid: boolean = sodium.crypto_sign_verify_detached(
    revocation.signature,
    canonical,
    rootPublicKey,
  );
  sodium.memzero(canonical);
  if (!valid) throw new Error("Agent revocation signature is invalid");
}

export async function createPrekeyCertificate(
  fields: PrekeyCertificateFields,
  agentSigningPrivateKey: Uint8Array,
): Promise<PrekeyCertificate> {
  await sodium.ready;
  requireLength(
    agentSigningPrivateKey,
    sodium.crypto_sign_SECRETKEYBYTES,
    "Agent signing private key",
  );
  const canonical: Uint8Array = encodePrekeyCertificateFields(fields);
  const signature: Uint8Array = sodium.crypto_sign_detached(canonical, agentSigningPrivateKey);
  sodium.memzero(canonical);
  return { ...fields, signature };
}

export async function verifyPrekeyCertificate(
  certificate: PrekeyCertificate,
  agentCertificate: AgentKeyCertificate,
  expectedAgentId: string,
  now: Date,
): Promise<void> {
  await sodium.ready;
  requireLength(certificate.prekeyPublicKey, sodium.crypto_box_PUBLICKEYBYTES, "Prekey public key");
  requireLength(certificate.signature, sodium.crypto_sign_BYTES, "Prekey signature");
  if (certificate.agentId !== expectedAgentId) throw new Error("Prekey identity mismatch");
  if (certificate.agentSigningKeyId !== agentCertificate.signingKeyId) {
    throw new Error("Prekey signer mismatch");
  }
  if (certificate.prekeyId !== keyId("mpk", certificate.prekeyPublicKey)) {
    throw new Error("Prekey identifier mismatch");
  }
  validateWindow(certificate.createdAt, certificate.expiresAt, now);
  const canonical: Uint8Array = encodePrekeyCertificateFields(certificate);
  const valid: boolean = sodium.crypto_sign_verify_detached(
    certificate.signature,
    canonical,
    agentCertificate.signingPublicKey,
  );
  sodium.memzero(canonical);
  if (!valid) throw new Error("Prekey certificate signature is invalid");
}
