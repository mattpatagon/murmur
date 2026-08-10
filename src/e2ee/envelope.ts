import sodium from "libsodium-wrappers";

import {
  completeEnvelopeHeader,
  type DecodedInnerCore,
  decodeInnerCore,
  encodeEnvelopeHeader,
  encodeInnerCore,
  encodeSignatureInput,
} from "./canonical-envelope.js";
import { paddedInnerLength, padInnerPayload } from "./padding.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeader,
  EnvelopeHeaderInput,
  EnvelopeRandom,
} from "./protocol.js";

const utf8Encoder: TextEncoder = new TextEncoder();
const utf8Decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true });

const sodiumRandom: EnvelopeRandom = {
  boxKeyPair(): BoxKeyPair {
    const pair: { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string } =
      sodium.crypto_box_keypair();
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  },
  bytes(length: number): Uint8Array {
    return sodium.randombytes_buf(length);
  },
};

function requireLength(value: Uint8Array, length: number, label: string): void {
  if (value.byteLength !== length) throw new Error(`${label} has an invalid length`);
}

function safeMemzero(value: Uint8Array | null): void {
  if (value !== null) sodium.memzero(value);
}

export async function encryptEnvelope(
  headerInput: EnvelopeHeaderInput,
  plaintext: string,
  senderSigningPrivateKey: Uint8Array,
  recipientPrekeyPublicKey: Uint8Array,
  random: EnvelopeRandom = sodiumRandom,
): Promise<EncryptedEnvelope> {
  await sodium.ready;
  requireLength(senderSigningPrivateKey, sodium.crypto_sign_SECRETKEYBYTES, "Sender signing key");
  requireLength(recipientPrekeyPublicKey, sodium.crypto_box_PUBLICKEYBYTES, "Recipient prekey");

  const plaintextBytes: Uint8Array = utf8Encoder.encode(plaintext);
  let innerCore: Uint8Array | null = null;
  let paddedInner: Uint8Array | null = null;
  let ephemeralPrivateKey: Uint8Array | null = null;
  try {
    const provisionalHeader: EnvelopeHeader = completeEnvelopeHeader(headerInput, 0);
    const provisionalOuter: Uint8Array = encodeEnvelopeHeader(provisionalHeader);
    const provisionalInner: Uint8Array = encodeInnerCore(provisionalOuter, plaintextBytes);
    const targetLength: number = paddedInnerLength(provisionalInner.byteLength);
    sodium.memzero(provisionalInner);

    const header: EnvelopeHeader = completeEnvelopeHeader(headerInput, targetLength);
    const outerHeaderBytes: Uint8Array = encodeEnvelopeHeader(header);
    innerCore = encodeInnerCore(outerHeaderBytes, plaintextBytes);
    const padding: Uint8Array = random.bytes(targetLength - innerCore.byteLength);
    paddedInner = padInnerPayload(innerCore, targetLength, padding);

    const ephemeral: BoxKeyPair = random.boxKeyPair();
    ephemeralPrivateKey = ephemeral.privateKey;
    requireLength(ephemeral.publicKey, sodium.crypto_box_PUBLICKEYBYTES, "Ephemeral public key");
    requireLength(ephemeralPrivateKey, sodium.crypto_box_SECRETKEYBYTES, "Ephemeral private key");
    const nonce: Uint8Array = random.bytes(sodium.crypto_box_NONCEBYTES);
    requireLength(nonce, sodium.crypto_box_NONCEBYTES, "Nonce");

    const ciphertext: Uint8Array = sodium.crypto_box_easy(
      paddedInner,
      nonce,
      recipientPrekeyPublicKey,
      ephemeralPrivateKey,
    );
    const signatureInput: Uint8Array = encodeSignatureInput(
      outerHeaderBytes,
      ephemeral.publicKey,
      nonce,
      ciphertext,
    );
    const signature: Uint8Array = sodium.crypto_sign_detached(
      signatureInput,
      senderSigningPrivateKey,
    );
    sodium.memzero(signatureInput);
    return {
      ciphertext,
      ephemeralPublicKey: ephemeral.publicKey,
      header,
      nonce,
      signature,
    };
  } finally {
    sodium.memzero(plaintextBytes);
    safeMemzero(innerCore);
    safeMemzero(paddedInner);
    safeMemzero(ephemeralPrivateKey);
  }
}

export async function decryptEnvelope(
  envelope: EncryptedEnvelope,
  senderSigningPublicKey: Uint8Array,
  recipientPrekeyPrivateKey: Uint8Array,
): Promise<string> {
  await sodium.ready;
  requireLength(senderSigningPublicKey, sodium.crypto_sign_PUBLICKEYBYTES, "Sender signing key");
  requireLength(recipientPrekeyPrivateKey, sodium.crypto_box_SECRETKEYBYTES, "Recipient prekey");
  requireLength(envelope.ephemeralPublicKey, sodium.crypto_box_PUBLICKEYBYTES, "Ephemeral key");
  requireLength(envelope.nonce, sodium.crypto_box_NONCEBYTES, "Nonce");
  requireLength(envelope.signature, sodium.crypto_sign_BYTES, "Signature");
  if (
    envelope.ciphertext.byteLength !==
    envelope.header.paddedLength + sodium.crypto_box_MACBYTES
  ) {
    throw new Error("Encrypted message verification failed");
  }

  const outerHeaderBytes: Uint8Array = encodeEnvelopeHeader(envelope.header);
  const signatureInput: Uint8Array = encodeSignatureInput(
    outerHeaderBytes,
    envelope.ephemeralPublicKey,
    envelope.nonce,
    envelope.ciphertext,
  );
  const validSignature: boolean = sodium.crypto_sign_verify_detached(
    envelope.signature,
    signatureInput,
    senderSigningPublicKey,
  );
  sodium.memzero(signatureInput);
  if (!validSignature) throw new Error("Encrypted message verification failed");

  let paddedInner: Uint8Array | null = null;
  let decoded: DecodedInnerCore | null = null;
  try {
    try {
      paddedInner = sodium.crypto_box_open_easy(
        envelope.ciphertext,
        envelope.nonce,
        envelope.ephemeralPublicKey,
        recipientPrekeyPrivateKey,
      );
    } catch (_error: unknown) {
      throw new Error("Encrypted message verification failed");
    }
    if (paddedInner.byteLength !== envelope.header.paddedLength) {
      throw new Error("Encrypted message verification failed");
    }
    decoded = decodeInnerCore(paddedInner);
    if (!sodium.memcmp(decoded.outerHeaderBytes, outerHeaderBytes)) {
      throw new Error("Encrypted message verification failed");
    }
    return utf8Decoder.decode(decoded.plaintextBytes);
  } catch (_error: unknown) {
    throw new Error("Encrypted message verification failed");
  } finally {
    safeMemzero(paddedInner);
    if (decoded !== null) {
      sodium.memzero(decoded.outerHeaderBytes);
      sodium.memzero(decoded.plaintextBytes);
    }
  }
}
