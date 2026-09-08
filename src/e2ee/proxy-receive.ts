import sodium from "libsodium-wrappers";

import {
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
} from "../domain/contracts.js";
import type { Clock, Instant } from "../domain/value-objects.js";
import { verifyAgentKeyCertificate, verifyAgentKeyRevocation } from "./certificates.js";
import { decryptEnvelope, verifyEnvelopeSignature } from "./envelope.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { CachedMessage, ExpectedPeerRoot, PeerPin, StoredPrekey } from "./local-vault-rows.js";
import type { EncryptedEnvelope } from "./protocol.js";
import {
  getE2eeCapability,
  type LocalPublishedIdentity,
  publishLocalIdentity,
} from "./proxy-identity.js";
import type { E2eeRemoteClient } from "./remote-client.js";
import {
  type PublicAgentSigningChain,
  parseEnvelopeDto,
  parseSigningChainDto,
} from "./wire-contracts.js";
import {
  type AcknowledgeEncryptedMessagesOutput,
  AcknowledgeEncryptedMessagesOutputSchema,
  type EncryptedMessageReadReceiptDto,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type EncryptedMessageDto,
  type GetEncryptedMessagesInput,
  GetEncryptedMessagesInputSchema,
  type WaitForEncryptedMessagesInput,
  WaitForEncryptedMessagesInputSchema,
  type WaitForEncryptedMessagesOutput,
  WaitForEncryptedMessagesOutputSchema,
} from "./wire-tools.js";

const MAX_CLOCK_SKEW_MS: number = 5 * 60 * 1000;
const utf8Encoder: TextEncoder = new TextEncoder();

export type EncryptionProof = {
  readonly contextBinding: "verified";
  readonly messageKind: "message" | "orchestration_request";
  readonly orchestratorPolicyId: string | null;
  readonly protocol: "murmur-e2ee-v1";
  readonly provenance: "sender_signed_server_asserted";
  readonly recipientPrekeyClass: "fallback" | "one_time";
  readonly senderAgentKeyId: string;
  readonly senderAuthority: "orchestrator" | "peer";
  readonly senderRootKeyId: string;
  readonly verificationMode: "organization" | "strict" | "tofu";
};

export type VerifiedDecryptedMessage = {
  readonly content: string;
  readonly proof: EncryptionProof;
  readonly wire: EncryptedMessageDto;
};

export type ReceiveEncryptedMessagesResult = {
  readonly agentId: string;
  readonly inboxVersion: number;
  readonly messages: readonly VerifiedDecryptedMessage[];
};

export type WaitForDecryptedMessagesResult = {
  readonly agentId: string;
  readonly messages: readonly VerifiedDecryptedMessage[];
  readonly timedOut: boolean;
};

export type EncryptedInboxReadOptions = {
  readonly acknowledgement: "automatic" | "none";
};

function validateEnvelopeWindow(envelope: EncryptedEnvelope, now: Instant): void {
  const createdAt: number = Date.parse(envelope.header.createdAt);
  const expiresAt: number = Date.parse(envelope.header.expiresAt);
  const nowMillis: number = now.toEpochMilliseconds();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > nowMillis + MAX_CLOCK_SKEW_MS ||
    expiresAt <= nowMillis ||
    expiresAt <= createdAt
  ) {
    throw new Error("Encrypted message verification failed");
  }
}

function validateRecipient(
  envelope: EncryptedEnvelope,
  tenantId: string,
  recipientId: string,
  identity: LocalPublishedIdentity,
): void {
  if (
    envelope.header.tenantId !== tenantId ||
    envelope.header.recipientId !== recipientId ||
    envelope.header.recipientRootKeyId !== identity.root.rootKeyId
  ) {
    throw new Error("Encrypted message verification failed");
  }
}

async function verifySender(
  vault: LocalE2eeVault,
  message: EncryptedMessageDto,
  envelope: EncryptedEnvelope,
  tenantId: string,
  now: Instant,
  trustOnFirstUse: boolean,
): Promise<{
  readonly chain: PublicAgentSigningChain;
  readonly verificationMode: PeerPin["verificationMode"];
}> {
  await sodium.ready;
  const chain: PublicAgentSigningChain = parseSigningChainDto(message.sender_chain);
  if (
    chain.rootKeyId !== envelope.header.senderRootKeyId ||
    chain.agentCertificate.signingKeyId !== envelope.header.senderAgentKeyId ||
    chain.agentCertificate.agentId !== envelope.header.senderId
  ) {
    throw new Error("Encrypted message verification failed");
  }
  await verifyAgentKeyCertificate(
    chain.agentCertificate,
    chain.rootPublicKey,
    envelope.header.senderId,
    new Date(now.toISOString()),
  );
  for (const revocation of chain.agentKeyRevocations) {
    await verifyAgentKeyRevocation(
      revocation,
      chain.rootPublicKey,
      envelope.header.senderId,
      new Date(now.toISOString()),
    );
  }
  let pin: PeerPin | null = vault.keys.getUsablePin(
    tenantId,
    envelope.header.senderId,
    new Date(now.toISOString()),
  );
  if (pin === null) {
    const expected: ExpectedPeerRoot | null = vault.keys.getExpectedPeerRoot(
      tenantId,
      envelope.header.senderId,
    );
    if (expected !== null && expected.rootKeyId !== chain.rootKeyId) {
      throw new Error("Encrypted message verification failed");
    }
    if (expected === null && !trustOnFirstUse) {
      throw new Error(
        `Sender '${envelope.header.senderId}' is not trusted. Verify its full root fingerprint, then run murmur e2ee trust.`,
      );
    }
    pin = await vault.keys.pinPeer({
      agentId: envelope.header.senderId,
      publicKey: chain.rootPublicKey,
      rootKeyId: chain.rootKeyId,
      tenantId,
      verificationMode: expected === null ? "tofu" : "strict",
      verifiedAt: now.toISOString(),
    });
  }
  if (pin.rootKeyId !== chain.rootKeyId || !sodium.memcmp(pin.publicKey, chain.rootPublicKey)) {
    throw new Error("Encrypted message verification failed");
  }
  return { chain, verificationMode: pin.verificationMode };
}

function receivedWireDigest(message: EncryptedMessageDto): Uint8Array {
  const bytes: Uint8Array = utf8Encoder.encode(
    JSON.stringify({ envelope: message.envelope, sender_chain: message.sender_chain }),
  );
  try {
    return sodium.crypto_generichash(32, bytes, null);
  } finally {
    sodium.memzero(bytes);
  }
}

function cachedMatches(
  cached: CachedMessage,
  envelope: EncryptedEnvelope,
  message: EncryptedMessageDto,
  wireDigest: Uint8Array,
): boolean {
  return (
    cached.tenantId === envelope.header.tenantId &&
    cached.senderId === envelope.header.senderId &&
    cached.recipientId === envelope.header.recipientId &&
    cached.pairCounter === envelope.header.pairCounter &&
    cached.expiresAt === envelope.header.expiresAt &&
    cached.tenantSequence === message.tenant_sequence &&
    sodium.memcmp(cached.wireDigest, wireDigest)
  );
}

async function decryptOne(
  vault: LocalE2eeVault,
  message: EncryptedMessageDto,
  tenantId: string,
  recipientId: string,
  identity: LocalPublishedIdentity,
  now: Instant,
  trustOnFirstUse: boolean,
): Promise<VerifiedDecryptedMessage> {
  const envelope: EncryptedEnvelope = parseEnvelopeDto(message.envelope);
  validateEnvelopeWindow(envelope, now);
  validateRecipient(envelope, tenantId, recipientId, identity);
  const sender: Awaited<ReturnType<typeof verifySender>> = await verifySender(
    vault,
    message,
    envelope,
    tenantId,
    now,
    trustOnFirstUse,
  );
  await verifyEnvelopeSignature(envelope, sender.chain.agentCertificate.signingPublicKey);
  const wireDigest: Uint8Array = receivedWireDigest(message);
  const cached: CachedMessage | null = vault.getCachedMessage(envelope.header.messageId);
  let plaintext: string;
  if (cached !== null) {
    if (!cachedMatches(cached, envelope, message, wireDigest)) {
      throw new Error("Encrypted message verification failed");
    }
    plaintext = cached.plaintext;
  } else {
    const prekey: StoredPrekey | null = vault.keys.getPrekey(envelope.header.recipientPrekeyId);
    if (
      prekey === null ||
      prekey.privateKey === null ||
      prekey.certificate.agentId !== recipientId ||
      prekey.certificate.agentSigningKeyId !== envelope.header.recipientAgentKeyId ||
      prekey.certificate.prekeyClass !== envelope.header.recipientPrekeyClass
    ) {
      throw new Error("Encrypted message verification failed");
    }
    plaintext = await decryptEnvelope(
      envelope,
      sender.chain.agentCertificate.signingPublicKey,
      prekey.privateKey,
    );
    vault.cacheDecryptedAndConsumePrekey({
      expiresAt: envelope.header.expiresAt,
      messageId: envelope.header.messageId,
      pairCounter: envelope.header.pairCounter,
      plaintext,
      prekeyId: envelope.header.recipientPrekeyId,
      recipientId,
      senderId: envelope.header.senderId,
      tenantSequence: message.tenant_sequence,
      tenantId,
      verifiedAt: now.toISOString(),
      wireDigest,
    });
  }
  return {
    content: plaintext,
    proof: {
      contextBinding: "verified",
      messageKind: envelope.header.messageKind,
      orchestratorPolicyId: envelope.header.orchestratorPolicyId,
      protocol: envelope.header.protocol,
      provenance: "sender_signed_server_asserted",
      recipientPrekeyClass: envelope.header.recipientPrekeyClass,
      senderAgentKeyId: envelope.header.senderAgentKeyId,
      senderAuthority: envelope.header.senderAuthority,
      senderRootKeyId: envelope.header.senderRootKeyId,
      verificationMode: sender.verificationMode,
    },
    wire: message,
  };
}

function validateSequenceOrder(
  messages: readonly EncryptedMessageDto[],
  afterSequence: number,
): number {
  let previous: number = afterSequence;
  messages.forEach((message: EncryptedMessageDto): void => {
    if (message.tenant_sequence <= previous) {
      throw new Error("Hosted Murmur returned an invalid encrypted inbox order");
    }
    previous = message.tenant_sequence;
  });
  return previous;
}

async function decryptMessages(
  vault: LocalE2eeVault,
  messages: readonly EncryptedMessageDto[],
  tenantId: string,
  recipientId: string,
  identity: LocalPublishedIdentity,
  now: Instant,
  trustOnFirstUse: boolean,
): Promise<readonly VerifiedDecryptedMessage[]> {
  const decrypted: VerifiedDecryptedMessage[] = [];
  for (const message of messages) {
    decrypted.push(
      await decryptOne(vault, message, tenantId, recipientId, identity, now, trustOnFirstUse),
    );
  }
  return decrypted;
}

async function acknowledgeDecryptedMessages(
  remote: E2eeRemoteClient,
  agentId: string,
  messages: readonly VerifiedDecryptedMessage[],
): Promise<readonly VerifiedDecryptedMessage[]> {
  const unreadMessageIds: string[] = messages
    .filter((message: VerifiedDecryptedMessage): boolean => message.wire.read_at === null)
    .map((message: VerifiedDecryptedMessage): string => message.wire.envelope.header.message_id);
  if (unreadMessageIds.length === 0) return messages;
  if (remote.acknowledgeMessages === undefined) {
    throw new Error("Hosted Murmur does not support encrypted message acknowledgement");
  }
  const acknowledgement: AcknowledgeEncryptedMessagesOutput =
    AcknowledgeEncryptedMessagesOutputSchema.parse(
      await remote.acknowledgeMessages({ agent_id: agentId, message_ids: unreadMessageIds }),
    );
  if (acknowledgement.updated !== unreadMessageIds.length) {
    throw new Error("Encrypted message acknowledgement failed");
  }
  const expectedMessageIds: ReadonlySet<string> = new Set(unreadMessageIds);
  const readAtByMessageId: Map<string, string> = new Map<string, string>();
  acknowledgement.receipts.forEach((messageReceipt: EncryptedMessageReadReceiptDto): void => {
    if (!expectedMessageIds.has(messageReceipt.message_id)) {
      throw new Error("Encrypted message acknowledgement failed");
    }
    readAtByMessageId.set(messageReceipt.message_id, messageReceipt.read_at);
  });
  return messages.map((message: VerifiedDecryptedMessage): VerifiedDecryptedMessage => {
    if (message.wire.read_at !== null) return message;
    const readAt: string | undefined = readAtByMessageId.get(
      message.wire.envelope.header.message_id,
    );
    if (readAt === undefined) throw new Error("Encrypted message acknowledgement failed");
    return { ...message, wire: { ...message.wire, read_at: readAt } };
  });
}

export async function receiveEncryptedMessages(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  clock: Clock,
  input: GetEncryptedMessagesInput,
  trustOnFirstUse: boolean = false,
  options: EncryptedInboxReadOptions = { acknowledgement: "automatic" },
): Promise<ReceiveEncryptedMessagesResult> {
  const parsedInput: GetEncryptedMessagesInput = GetEncryptedMessagesInputSchema.parse(input);
  const now: Instant = clock.now();
  const capability: Awaited<ReturnType<typeof getE2eeCapability>> = await getE2eeCapability(
    remote,
    false,
  );
  const identity: LocalPublishedIdentity = await publishLocalIdentity(
    vault,
    remote,
    parsedInput.agent_id,
    now,
    parsedInput.session_key,
  );
  const output: EncryptedInboxOutput = EncryptedInboxOutputSchema.parse(
    await remote.getEncryptedMessages(parsedInput),
  );
  if (output.agent_id !== parsedInput.agent_id) {
    throw new Error("Hosted Murmur changed the encrypted inbox identity");
  }
  const newestSequence: number = validateSequenceOrder(output.messages, parsedInput.after_sequence);
  if (output.inbox_version < newestSequence) {
    throw new Error("Hosted Murmur returned an invalid encrypted inbox version");
  }
  const decryptedMessages: readonly VerifiedDecryptedMessage[] = await decryptMessages(
    vault,
    output.messages,
    capability.tenant_id,
    parsedInput.agent_id,
    identity,
    now,
    trustOnFirstUse,
  );
  const messages: readonly VerifiedDecryptedMessage[] =
    options.acknowledgement === "automatic"
      ? await acknowledgeDecryptedMessages(remote, parsedInput.agent_id, decryptedMessages)
      : decryptedMessages;
  return { agentId: parsedInput.agent_id, inboxVersion: output.inbox_version, messages };
}

export async function waitForDecryptedMessages(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  clock: Clock,
  input: WaitForEncryptedMessagesInput,
  trustOnFirstUse: boolean = false,
  options: EncryptedInboxReadOptions = { acknowledgement: "automatic" },
): Promise<WaitForDecryptedMessagesResult> {
  const parsedInput: WaitForEncryptedMessagesInput =
    WaitForEncryptedMessagesInputSchema.parse(input);
  const now: Instant = clock.now();
  const capability: Awaited<ReturnType<typeof getE2eeCapability>> = await getE2eeCapability(
    remote,
    false,
  );
  const identity: LocalPublishedIdentity = await publishLocalIdentity(
    vault,
    remote,
    parsedInput.agent_id,
    now,
    parsedInput.session_key,
  );
  const output: WaitForEncryptedMessagesOutput = WaitForEncryptedMessagesOutputSchema.parse(
    await remote.waitForEncryptedMessages(parsedInput),
  );
  if (output.agent_id !== parsedInput.agent_id) {
    throw new Error("Hosted Murmur changed the encrypted wait identity");
  }
  validateSequenceOrder(output.messages, parsedInput.after_sequence);
  const decryptedMessages: readonly VerifiedDecryptedMessage[] = await decryptMessages(
    vault,
    output.messages,
    capability.tenant_id,
    parsedInput.agent_id,
    identity,
    now,
    trustOnFirstUse,
  );
  const messages: readonly VerifiedDecryptedMessage[] =
    options.acknowledgement === "automatic"
      ? await acknowledgeDecryptedMessages(remote, parsedInput.agent_id, decryptedMessages)
      : decryptedMessages;
  return { agentId: parsedInput.agent_id, messages, timedOut: output.timed_out };
}

export async function markEncryptedMessagesRead(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  input: MarkMessagesReadInput,
): Promise<MarkMessagesReadOutput> {
  const parsedInput: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(input);
  await getE2eeCapability(remote, false);
  const output: MarkMessagesReadOutput = MarkMessagesReadOutputSchema.parse(
    await remote.markMessagesRead(parsedInput),
  );
  vault.purgeCachedMessages(parsedInput.message_ids);
  return output;
}
