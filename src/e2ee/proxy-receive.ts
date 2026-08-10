import sodium from "libsodium-wrappers";

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
  const messages: VerifiedDecryptedMessage[] = [];
  for (const message of output.messages) {
    messages.push(
      await decryptOne(
        vault,
        message,
        capability.tenant_id,
        parsedInput.agent_id,
        identity,
        now,
        trustOnFirstUse,
      ),
    );
  }
  return { agentId: parsedInput.agent_id, inboxVersion: output.inbox_version, messages };
}
