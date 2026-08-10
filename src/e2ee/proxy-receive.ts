import sodium from "libsodium-wrappers";

import {
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
} from "../domain/contracts.js";
import type { Clock, Instant } from "../domain/value-objects.js";
import { verifyAgentKeyCertificate } from "./certificates.js";
import { decryptEnvelope, verifyEnvelopeSignature } from "./envelope.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { CachedMessage, PeerPin, StoredPrekey } from "./local-vault-rows.js";
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

export type EncryptionProof = {
  readonly contextBinding: "verified";
  readonly protocol: "murmur-e2ee-v1";
  readonly provenance: "sender_signed_server_asserted";
  readonly recipientPrekeyClass: "fallback" | "one_time";
  readonly senderAgentKeyId: string;
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
    envelope.header.recipientRootKeyId !== identity.root.rootKeyId ||
    envelope.header.recipientAgentKeyId !== identity.agent.certificate.signingKeyId
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
  let pin: PeerPin | null = vault.keys.getUsablePin(
    tenantId,
    envelope.header.senderId,
    new Date(now.toISOString()),
  );
  if (pin === null) {
    if (!trustOnFirstUse) {
      throw new Error(
        `Sender '${envelope.header.senderId}' is not trusted. Verify its full root fingerprint, then run murmur e2ee trust.`,
      );
    }
    pin = await vault.keys.pinPeer({
      agentId: envelope.header.senderId,
      publicKey: chain.rootPublicKey,
      rootKeyId: chain.rootKeyId,
      tenantId,
      verificationMode: "tofu",
      verifiedAt: now.toISOString(),
    });
  }
  if (pin.rootKeyId !== chain.rootKeyId || !sodium.memcmp(pin.publicKey, chain.rootPublicKey)) {
    throw new Error("Encrypted message verification failed");
  }
  return { chain, verificationMode: pin.verificationMode };
}

function cachedMatches(cached: CachedMessage, envelope: EncryptedEnvelope): boolean {
  return (
    cached.tenantId === envelope.header.tenantId &&
    cached.senderId === envelope.header.senderId &&
    cached.recipientId === envelope.header.recipientId &&
    cached.pairCounter === envelope.header.pairCounter &&
    cached.expiresAt === envelope.header.expiresAt
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
  const cached: CachedMessage | null = vault.getCachedMessage(envelope.header.messageId);
  let plaintext: string;
  if (cached !== null) {
    if (!cachedMatches(cached, envelope)) throw new Error("Encrypted message verification failed");
    plaintext = cached.plaintext;
  } else {
    const prekey: StoredPrekey | null = vault.keys.getPrekey(envelope.header.recipientPrekeyId);
    if (
      prekey === null ||
      prekey.privateKey === null ||
      prekey.certificate.agentId !== recipientId ||
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
      tenantId,
      verifiedAt: now.toISOString(),
    });
  }
  return {
    content: plaintext,
    proof: {
      contextBinding: "verified",
      protocol: envelope.header.protocol,
      provenance: "sender_signed_server_asserted",
      recipientPrekeyClass: envelope.header.recipientPrekeyClass,
      senderAgentKeyId: envelope.header.senderAgentKeyId,
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

export async function receiveEncryptedMessages(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  clock: Clock,
  input: GetEncryptedMessagesInput,
  trustOnFirstUse: boolean = false,
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
  const messages: readonly VerifiedDecryptedMessage[] = await decryptMessages(
    vault,
    output.messages,
    capability.tenant_id,
    parsedInput.agent_id,
    identity,
    now,
    trustOnFirstUse,
  );
  return { agentId: parsedInput.agent_id, inboxVersion: output.inbox_version, messages };
}

export async function waitForDecryptedMessages(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  clock: Clock,
  input: WaitForEncryptedMessagesInput,
  trustOnFirstUse: boolean = false,
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
  );
  const output: WaitForEncryptedMessagesOutput = WaitForEncryptedMessagesOutputSchema.parse(
    await remote.waitForEncryptedMessages(parsedInput),
  );
  if (output.agent_id !== parsedInput.agent_id) {
    throw new Error("Hosted Murmur changed the encrypted wait identity");
  }
  validateSequenceOrder(output.messages, parsedInput.after_sequence);
  const messages: readonly VerifiedDecryptedMessage[] = await decryptMessages(
    vault,
    output.messages,
    capability.tenant_id,
    parsedInput.agent_id,
    identity,
    now,
    trustOnFirstUse,
  );
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
