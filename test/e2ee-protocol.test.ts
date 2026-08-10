import { expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import {
  completeEnvelopeHeader,
  encodeEnvelopeHeader,
  encodeSignatureInput,
} from "../src/e2ee/canonical-envelope.js";
import {
  type AgentKeyCertificate,
  type AgentKeyCertificateFields,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  type PrekeyCertificateFields,
  prekeyId,
  rootKeyId,
  verifyAgentKeyCertificate,
  verifyPrekeyCertificate,
} from "../src/e2ee/certificates.js";
import { decryptEnvelope, encryptEnvelope } from "../src/e2ee/envelope.js";
import { paddedInnerLength } from "../src/e2ee/padding.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeader,
  EnvelopeHeaderInput,
  EnvelopeRandom,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";

function fixedBytes(length: number, start: number): Uint8Array {
  const bytes: Uint8Array = new Uint8Array(length);
  for (let index: number = 0; index < length; index += 1) bytes[index] = (start + index) % 256;
  return bytes;
}

function flipFirst(bytes: Uint8Array): Uint8Array {
  const changed: Uint8Array = bytes.slice();
  const first: number | undefined = changed[0];
  if (first === undefined) throw new Error("Expected nonempty bytes");
  changed[0] = first ^ 1;
  return changed;
}

class DeterministicRandom implements EnvelopeRandom {
  readonly #pair: BoxKeyPair;
  public lastPrivateKey: Uint8Array | null = null;
  #nextByte: number = 31;

  public constructor(pair: BoxKeyPair) {
    this.#pair = pair;
  }

  public boxKeyPair(): BoxKeyPair {
    const privateKey: Uint8Array = this.#pair.privateKey.slice();
    this.lastPrivateKey = privateKey;
    return { privateKey, publicKey: this.#pair.publicKey.slice() };
  }

  public bytes(length: number): Uint8Array {
    const bytes: Uint8Array = fixedBytes(length, this.#nextByte);
    this.#nextByte = (this.#nextByte + 17) % 256;
    return bytes;
  }
}

function baseHeaderInput(): EnvelopeHeaderInput {
  return {
    branchName: "feature/e2ee",
    broadcastId: null,
    client: "codex",
    createdAt: "2026-08-10T17:00:00.000Z",
    expiresAt: "2026-09-09T17:00:00.000Z",
    idempotencyKey: "send-0001",
    messageId: "11111111-1111-4111-8111-111111111111",
    messageKind: "message",
    orchestratorPolicyId: null,
    pairCounter: 1,
    recipientAgentKeyId: `mak_${"A".repeat(43)}`,
    recipientId: "machine-b:codex:repo-b:recipient",
    recipientPrekeyClass: "one_time",
    recipientPrekeyId: `mpk_${"B".repeat(43)}`,
    recipientRootKeyId: `mrk_${"C".repeat(43)}`,
    repositoryName: "mattpatagon/murmur",
    senderAgentKeyId: `mak_${"D".repeat(43)}`,
    senderAuthority: "peer",
    senderId: "machine-a:codex:repo-a:sender",
    senderRootKeyId: `mrk_${"E".repeat(43)}`,
    tenantId: "22222222-2222-4222-8222-222222222222",
    threadId: "33333333-3333-4333-8333-333333333333",
  };
}

async function envelopeKeys(): Promise<{
  readonly ephemeral: BoxKeyPair;
  readonly recipient: BoxKeyPair;
  readonly sender: SigningKeyPair;
}> {
  const sender: SigningKeyPair = await createSigningKeyPair(fixedBytes(32, 1));
  const recipient: BoxKeyPair = await createBoxKeyPair(fixedBytes(32, 65));
  const ephemeral: BoxKeyPair = await createBoxKeyPair(fixedBytes(32, 129));
  return { ephemeral, recipient, sender };
}

test("certifies agent signing keys and recipient prekeys", async (): Promise<void> => {
  const root: SigningKeyPair = await createSigningKeyPair(fixedBytes(32, 3));
  const agent: SigningKeyPair = await createSigningKeyPair(fixedBytes(32, 41));
  const prekey: BoxKeyPair = await createBoxKeyPair(fixedBytes(32, 79));
  const agentFields: AgentKeyCertificateFields = {
    agentId: "machine:codex:repo:alice",
    createdAt: "2026-08-10T16:00:00.000Z",
    expiresAt: "2026-11-08T16:00:00.000Z",
    rootKeyId: await rootKeyId(root.publicKey),
    signingKeyId: await agentSigningKeyId(agent.publicKey),
    signingPublicKey: agent.publicKey,
  };
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    agentFields,
    root.privateKey,
  );
  const prekeyFields: PrekeyCertificateFields = {
    agentId: agentFields.agentId,
    agentSigningKeyId: agentFields.signingKeyId,
    createdAt: "2026-08-10T16:30:00.000Z",
    expiresAt: "2026-09-09T16:30:00.000Z",
    prekeyClass: "one_time",
    prekeyId: await prekeyId(prekey.publicKey),
    prekeyPublicKey: prekey.publicKey,
  };
  const prekeyCertificate: PrekeyCertificate = await createPrekeyCertificate(
    prekeyFields,
    agent.privateKey,
  );

  await verifyAgentKeyCertificate(
    agentCertificate,
    root.publicKey,
    agentFields.agentId,
    new Date("2026-08-10T17:00:00.000Z"),
  );
  await verifyPrekeyCertificate(
    prekeyCertificate,
    agentCertificate,
    agentFields.agentId,
    new Date("2026-08-10T17:00:00.000Z"),
  );
  expect(agentFields.rootKeyId.startsWith("mrk_")).toBe(true);
  expect(agentFields.signingKeyId.startsWith("mak_")).toBe(true);
  expect(prekeyFields.prekeyId.startsWith("mpk_")).toBe(true);

  const tampered: AgentKeyCertificate = {
    ...agentCertificate,
    signature: flipFirst(agentCertificate.signature),
  };
  await expect(
    verifyAgentKeyCertificate(
      tampered,
      root.publicKey,
      agentFields.agentId,
      new Date("2026-08-10T17:00:00.000Z"),
    ),
  ).rejects.toThrow("signature is invalid");
  await expect(
    verifyPrekeyCertificate(
      prekeyCertificate,
      agentCertificate,
      "machine:codex:repo:mallory",
      new Date("2026-08-10T17:00:00.000Z"),
    ),
  ).rejects.toThrow("identity mismatch");
});

test("round trips a signed encrypted envelope and wipes the ephemeral secret", async (): Promise<void> => {
  const keys: Awaited<ReturnType<typeof envelopeKeys>> = await envelopeKeys();
  const random: DeterministicRandom = new DeterministicRandom(keys.ephemeral);
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    baseHeaderInput(),
    "private sentinel 🔐",
    keys.sender.privateKey,
    keys.recipient.publicKey,
    random,
  );
  const plaintext: string = await decryptEnvelope(
    envelope,
    keys.sender.publicKey,
    keys.recipient.privateKey,
  );
  expect(plaintext).toBe("private sentinel 🔐");
  expect(envelope.ciphertext.byteLength).toBe(envelope.header.paddedLength + 16);
  const wiped: Uint8Array | null = random.lastPrivateKey;
  if (wiped === null) throw new Error("Expected an ephemeral private key");
  expect(wiped.every((value: number): boolean => value === 0)).toBe(true);
});

test("rejects ciphertext tampering, cross-tenant relabeling, and same-signer rebinding", async (): Promise<void> => {
  await sodium.ready;
  const keys: Awaited<ReturnType<typeof envelopeKeys>> = await envelopeKeys();
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    baseHeaderInput(),
    "bound payload",
    keys.sender.privateKey,
    keys.recipient.publicKey,
    new DeterministicRandom(keys.ephemeral),
  );
  const tamperedCiphertext: EncryptedEnvelope = {
    ...envelope,
    ciphertext: flipFirst(envelope.ciphertext),
  };
  await expect(
    decryptEnvelope(tamperedCiphertext, keys.sender.publicKey, keys.recipient.privateKey),
  ).rejects.toThrow("Encrypted message verification failed");

  const otherTenant: EncryptedEnvelope = {
    ...envelope,
    header: { ...envelope.header, tenantId: "44444444-4444-4444-8444-444444444444" },
  };
  await expect(
    decryptEnvelope(otherTenant, keys.sender.publicKey, keys.recipient.privateKey),
  ).rejects.toThrow("Encrypted message verification failed");

  const reboundHeader: EnvelopeHeader = { ...envelope.header, recipientId: "other-recipient" };
  const reboundOuter: Uint8Array = encodeEnvelopeHeader(reboundHeader);
  const reboundSignatureInput: Uint8Array = encodeSignatureInput(
    reboundOuter,
    envelope.ephemeralPublicKey,
    envelope.nonce,
    envelope.ciphertext,
  );
  const reboundSignature: Uint8Array = sodium.crypto_sign_detached(
    reboundSignatureInput,
    keys.sender.privateKey,
  );
  sodium.memzero(reboundSignatureInput);
  const rebound: EncryptedEnvelope = {
    ...envelope,
    header: reboundHeader,
    signature: reboundSignature,
  };
  await expect(
    decryptEnvelope(rebound, keys.sender.publicKey, keys.recipient.privateKey),
  ).rejects.toThrow("Encrypted message verification failed");
});

test("hides exact plaintext length inside the same visible padding bucket", async (): Promise<void> => {
  const keys: Awaited<ReturnType<typeof envelopeKeys>> = await envelopeKeys();
  const shortEnvelope: EncryptedEnvelope = await encryptEnvelope(
    baseHeaderInput(),
    "a",
    keys.sender.privateKey,
    keys.recipient.publicKey,
    new DeterministicRandom(keys.ephemeral),
  );
  const longerEnvelope: EncryptedEnvelope = await encryptEnvelope(
    { ...baseHeaderInput(), messageId: "55555555-5555-4555-8555-555555555555" },
    "a substantially longer secret",
    keys.sender.privateKey,
    keys.recipient.publicKey,
    new DeterministicRandom(keys.ephemeral),
  );
  expect(shortEnvelope.header.paddedLength).toBe(longerEnvelope.header.paddedLength);
  expect(shortEnvelope.ciphertext.byteLength).toBe(longerEnvelope.ciphertext.byteLength);
  expect(Object.keys(shortEnvelope.header)).not.toContain("plaintextLength");
});

test("uses fixed canonical buckets and a stable outer-header vector", async (): Promise<void> => {
  await sodium.ready;
  expect(paddedInnerLength(0)).toBe(512);
  expect(paddedInnerLength(512)).toBe(512);
  expect(paddedInnerLength(513)).toBe(1024);
  expect((): number => paddedInnerLength(512 * 1024 + 1)).toThrow("exceeds");
  const header: EnvelopeHeader = completeEnvelopeHeader(baseHeaderInput(), 1024);
  const encoded: Uint8Array = encodeEnvelopeHeader(header);
  const digest: Uint8Array = sodium.crypto_generichash(32, encoded, null);
  expect(encoded.byteLength).toBe(708);
  expect(sodium.to_hex(digest)).toBe(
    // biome-ignore lint/security/noSecrets: This is the documented public vector digest, not secret material.
    "feac7159f60e1f6760d2c2e589b19fd221279b71e12d226feda484d4ec2cd95a",
  );
  sodium.memzero(digest);
});
