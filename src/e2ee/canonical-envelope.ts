import { AgentClientNameSchema } from "../domain/client-provenance.js";
import { BinaryReader, BinaryWriter } from "./encoding.js";
import { paddedInnerLength } from "./padding.js";
import {
  E2EE_CIPHER_SUITE,
  E2EE_PADDING_SCHEME,
  E2EE_PROTOCOL,
  type EnvelopeHeader,
  type EnvelopeHeaderInput,
} from "./protocol.js";

const OUTER_DOMAIN: string = "murmur-e2ee-v1/outer";
const INNER_DOMAIN: string = "murmur-e2ee-v1/inner";
const SIGNATURE_DOMAIN: string = "murmur-e2ee-v1/signature";

export function completeEnvelopeHeader(
  input: EnvelopeHeaderInput,
  paddedLength: number,
): EnvelopeHeader {
  return {
    ...input,
    cipherSuite: E2EE_CIPHER_SUITE,
    paddedLength,
    paddingScheme: E2EE_PADDING_SCHEME,
    protocol: E2EE_PROTOCOL,
  };
}

function validateHeader(header: EnvelopeHeader): void {
  if (header.protocol !== E2EE_PROTOCOL) throw new Error("Unsupported encryption protocol");
  if (header.cipherSuite !== E2EE_CIPHER_SUITE) throw new Error("Unsupported cipher suite");
  if (header.paddingScheme !== E2EE_PADDING_SCHEME) throw new Error("Unsupported padding scheme");
  if (!Number.isSafeInteger(header.pairCounter) || header.pairCounter < 1) {
    throw new Error("Pair counter must be a positive safe integer");
  }
  if (!Number.isSafeInteger(header.paddedLength) || header.paddedLength < 0) {
    throw new Error("Padded length must be a nonnegative safe integer");
  }
  if (header.client !== null && !AgentClientNameSchema.safeParse(header.client).success) {
    throw new Error("Envelope client is invalid");
  }
  const isOrchestration: boolean = header.messageKind === "orchestration_request";
  if (
    (isOrchestration && header.senderAuthority !== "peer") ||
    isOrchestration !== (header.orchestratorPolicyId !== null)
  ) {
    throw new Error("Envelope provenance is inconsistent");
  }
}

export function encodeEnvelopeHeader(header: EnvelopeHeader): Uint8Array {
  validateHeader(header);
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(OUTER_DOMAIN);
  writer.writeString(header.protocol);
  writer.writeString(header.cipherSuite);
  writer.writeString(header.tenantId);
  writer.writeString(header.messageId);
  writer.writeString(header.idempotencyKey);
  writer.writeNullableString(header.broadcastId);
  writer.writeU64(header.pairCounter);
  writer.writeString(header.senderId);
  writer.writeString(header.recipientId);
  writer.writeString(header.threadId);
  writer.writeNullableString(header.repositoryName);
  writer.writeNullableString(header.branchName);
  writer.writeNullableString(header.client);
  writer.writeString(header.createdAt);
  writer.writeString(header.expiresAt);
  writer.writeString(header.senderAuthority);
  writer.writeString(header.messageKind);
  writer.writeNullableString(header.orchestratorPolicyId);
  writer.writeString(header.recipientRootKeyId);
  writer.writeString(header.recipientAgentKeyId);
  writer.writeString(header.recipientPrekeyId);
  writer.writeString(header.recipientPrekeyClass);
  writer.writeString(header.senderRootKeyId);
  writer.writeString(header.senderAgentKeyId);
  writer.writeU32(header.paddedLength);
  writer.writeString(header.paddingScheme);
  return writer.finish();
}

export function encodeInnerCore(
  outerHeaderBytes: Uint8Array,
  plaintextBytes: Uint8Array,
): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(INNER_DOMAIN);
  writer.writeBytes(outerHeaderBytes);
  writer.writeBytes(plaintextBytes);
  return writer.finish();
}

export type DecodedInnerCore = {
  readonly outerHeaderBytes: Uint8Array;
  readonly plaintextBytes: Uint8Array;
};

export function decodeInnerCore(paddedInner: Uint8Array): DecodedInnerCore {
  const reader: BinaryReader = new BinaryReader(paddedInner);
  if (reader.readString() !== INNER_DOMAIN) throw new Error("Invalid encrypted payload domain");
  const outerHeaderBytes: Uint8Array = reader.readBytes();
  const plaintextBytes: Uint8Array = reader.readBytes();
  const unpaddedLength: number = paddedInner.byteLength - reader.remaining;
  if (paddedInnerLength(unpaddedLength) !== paddedInner.byteLength) {
    throw new Error("Encrypted payload does not use its canonical padding bucket");
  }
  reader.skipRemaining();
  return { outerHeaderBytes, plaintextBytes };
}

export function encodeSignatureInput(
  outerHeaderBytes: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(SIGNATURE_DOMAIN);
  writer.writeBytes(outerHeaderBytes);
  writer.writeBytes(ephemeralPublicKey);
  writer.writeBytes(nonce);
  writer.writeBytes(ciphertext);
  return writer.finish();
}
