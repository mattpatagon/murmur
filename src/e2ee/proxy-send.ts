import { randomUUID } from "node:crypto";

import sodium from "libsodium-wrappers";

import type { Clock, Instant } from "../domain/value-objects.js";
import { BinaryWriter } from "./encoding.js";
import { encryptEnvelope } from "./envelope.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { OutboxItem, SentReceipt } from "./local-vault-rows.js";
import type { BoxKeyPair, EncryptedEnvelope, EnvelopeRandom } from "./protocol.js";
import {
  getE2eeCapability,
  type LocalPublishedIdentity,
  publishLocalIdentity,
  type VerifiedClaim,
  verifyClaimedPeer,
} from "./proxy-identity.js";
import { type E2eeRemoteClient, EncryptionClaimExpiredError } from "./remote-client.js";
import {
  envelopeToDto,
  parseEnvelopeDto,
  parseSerializedEnvelope,
  serializeEnvelope,
} from "./wire-contracts.js";
import {
  type ClaimedProvenanceDto,
  type E2eeCapabilityOutput,
  type E2eeMessageContextDto,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
} from "./wire-tools.js";

const RETENTION_DAYS: number = 30;
const MAX_CLAIM_ATTEMPTS: number = 2;
const DIGEST_DOMAIN: string = "murmur-e2ee-v1/outbox-digest";

export type ProxySendInput = {
  readonly content: string;
  readonly context: E2eeMessageContextDto;
  readonly idempotencyKey: string | null;
  readonly recipientId: string;
  readonly senderId: string;
  readonly threadId: string | null;
};

export type ProxySendResult = {
  readonly content: string;
  readonly output: PutEncryptedMessageOutput;
  readonly verificationMode: "organization" | "strict" | "tofu";
};

export type ProxySendOptions = {
  readonly expectedProvenance: ClaimedProvenanceDto;
  readonly random: EnvelopeRandom;
  readonly trustOnFirstUse: boolean;
  readonly uuid: () => string;
};

export class SodiumEnvelopeRandom implements EnvelopeRandom {
  public boxKeyPair(): BoxKeyPair {
    const pair: { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string } =
      sodium.crypto_box_keypair();
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  }

  public bytes(length: number): Uint8Array {
    return sodium.randombytes_buf(length);
  }
}

export function defaultProxySendOptions(): ProxySendOptions {
  return {
    expectedProvenance: {
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    },
    random: new SodiumEnvelopeRandom(),
    trustOnFirstUse: false,
    uuid: randomUUID,
  };
}

export function claimProvenanceMatches(
  actual: ClaimedProvenanceDto,
  expected: ClaimedProvenanceDto,
): boolean {
  return (
    actual.message_kind === expected.message_kind &&
    actual.orchestrator_policy_id === expected.orchestrator_policy_id &&
    actual.sender_authority === expected.sender_authority
  );
}

async function digestOutbox(
  rootPrivateKey: Uint8Array,
  logicalId: string,
  input: ProxySendInput,
): Promise<Uint8Array> {
  await sodium.ready;
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(DIGEST_DOMAIN);
  writer.writeString(logicalId);
  writer.writeString(input.senderId);
  writer.writeString(input.recipientId);
  writer.writeNullableString(input.threadId);
  writer.writeString(input.context.repository);
  writer.writeString(input.context.branch);
  writer.writeString(input.context.client);
  writer.writeString(input.content);
  const canonical: Uint8Array = writer.finish();
  try {
    return sodium.crypto_generichash(32, canonical, rootPrivateKey);
  } finally {
    sodium.memzero(canonical);
  }
}

export function envelopeExpiry(
  now: Instant,
  identity: LocalPublishedIdentity,
  claim: VerifiedClaim,
): string {
  const expiresAt: number = Math.min(
    now.addDays(RETENTION_DAYS).toEpochMilliseconds(),
    Date.parse(identity.agent.certificate.expiresAt),
    Date.parse(claim.recipient.agentCertificate.expiresAt),
    Date.parse(claim.prekey.expiresAt),
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now.toEpochMilliseconds()) {
    throw new Error("No valid encryption key window remains; rotate or replenish keys, then retry");
  }
  return new Date(expiresAt).toISOString();
}

async function submitStoredEnvelope(
  remote: E2eeRemoteClient,
  submission: {
    readonly claimId: string | null;
    readonly envelopeJson: string | null;
  },
): Promise<PutEncryptedMessageOutput> {
  if (submission.claimId === null || submission.envelopeJson === null) {
    throw new Error("Local encrypted outbox is incomplete");
  }
  const envelope: EncryptedEnvelope = parseSerializedEnvelope(submission.envelopeJson);
  const output: PutEncryptedMessageOutput = PutEncryptedMessageOutputSchema.parse(
    await remote.putEncryptedMessage({
      claim_id: submission.claimId,
      envelope: envelopeToDto(envelope),
    }),
  );
  if (
    serializeEnvelope(envelope) !== serializeEnvelope(parseEnvelopeDto(output.message.envelope))
  ) {
    throw new Error("Hosted Murmur changed the committed encrypted envelope");
  }
  return output;
}

async function createStoredEnvelope(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  identity: LocalPublishedIdentity,
  capability: E2eeCapabilityOutput,
  input: ProxySendInput,
  outbox: OutboxItem,
  now: Instant,
  options: ProxySendOptions,
): Promise<{
  readonly outbox: OutboxItem;
  readonly verificationMode: VerifiedClaim["verificationMode"];
}> {
  const verified: VerifiedClaim = await verifyClaimedPeer(
    vault,
    await remote.claimEncryptionPrekey({
      context: input.context,
      recipient_id: input.recipientId,
      sender_id: input.senderId,
    }),
    input.recipientId,
    capability.tenant_id,
    now,
    options.trustOnFirstUse,
  );
  if (!claimProvenanceMatches(verified.claim.provenance, options.expectedProvenance)) {
    throw new Error("Hosted Murmur returned unexpected sender provenance");
  }
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    {
      branchName: input.context.branch,
      broadcastId: null,
      client: input.context.client,
      createdAt: now.toISOString(),
      expiresAt: envelopeExpiry(now, identity, verified),
      idempotencyKey: outbox.logicalId,
      messageId: options.uuid(),
      messageKind: verified.claim.provenance.message_kind,
      orchestratorPolicyId: verified.claim.provenance.orchestrator_policy_id,
      pairCounter: outbox.pairCounter,
      recipientAgentKeyId: verified.recipient.agentCertificate.signingKeyId,
      recipientId: input.recipientId,
      recipientPrekeyClass: verified.prekey.prekeyClass,
      recipientPrekeyId: verified.prekey.prekeyId,
      recipientRootKeyId: verified.recipient.rootKeyId,
      repositoryName: input.context.repository,
      senderAgentKeyId: identity.agent.certificate.signingKeyId,
      senderAuthority: verified.claim.provenance.sender_authority,
      senderId: input.senderId,
      senderRootKeyId: identity.root.rootKeyId,
      tenantId: capability.tenant_id,
      threadId: outbox.threadId,
    },
    input.content,
    identity.agent.privateKey,
    verified.prekey.prekeyPublicKey,
    options.random,
  );
  if (envelope.ciphertext.byteLength > capability.max_ciphertext_bytes) {
    throw new Error("Encrypted message exceeds the hosted ciphertext limit");
  }
  return {
    outbox: vault.setOutboxEnvelope(
      outbox.logicalId,
      verified.claim.claim_id,
      serializeEnvelope(envelope),
    ),
    verificationMode: verified.verificationMode,
  };
}

export async function sendEncryptedMessage(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  clock: Clock,
  input: ProxySendInput,
  options: ProxySendOptions = defaultProxySendOptions(),
): Promise<ProxySendResult> {
  await sodium.ready;
  const now: Instant = clock.now();
  const capability: E2eeCapabilityOutput = await getE2eeCapability(remote, false);
  const identity: LocalPublishedIdentity = await publishLocalIdentity(
    vault,
    remote,
    input.senderId,
    now,
  );
  const logicalId: string = input.idempotencyKey === null ? options.uuid() : input.idempotencyKey;
  const plaintextDigest: Uint8Array = await digestOutbox(
    identity.root.privateKey,
    logicalId,
    input,
  );
  const receipt: SentReceipt | null = vault.getSentReceipt(logicalId);
  if (receipt !== null) {
    if (
      receipt.tenantId !== capability.tenant_id ||
      receipt.senderId !== input.senderId ||
      receipt.recipientId !== input.recipientId ||
      !sodium.memcmp(receipt.plaintextDigest, plaintextDigest)
    ) {
      throw new Error("Sent receipt idempotency conflict");
    }
    try {
      const output: PutEncryptedMessageOutput = await submitStoredEnvelope(remote, receipt);
      return { content: input.content, output, verificationMode: receipt.verificationMode };
    } catch (error: unknown) {
      if (error instanceof EncryptionClaimExpiredError) {
        throw new Error("Hosted Murmur cannot resolve a committed encrypted retry");
      }
      throw error;
    }
  }
  const existingOutbox: OutboxItem | null = vault.getOutbox(logicalId);
  const threadId: string =
    input.threadId === null
      ? existingOutbox === null
        ? options.uuid()
        : existingOutbox.threadId
      : input.threadId;
  let outbox: OutboxItem = vault.beginOutbox({
    createdAt: now.toISOString(),
    logicalId,
    plaintext: input.content,
    plaintextDigest,
    recipientId: input.recipientId,
    senderId: input.senderId,
    tenantId: capability.tenant_id,
    threadId,
  });
  let verificationMode: VerifiedClaim["verificationMode"] = "strict";
  for (let attempt: number = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    if (outbox.claimId === null && outbox.envelopeJson === null) {
      const created: Awaited<ReturnType<typeof createStoredEnvelope>> = await createStoredEnvelope(
        vault,
        remote,
        identity,
        capability,
        input,
        outbox,
        now,
        options,
      );
      outbox = created.outbox;
      verificationMode = created.verificationMode;
    }
    try {
      const output: PutEncryptedMessageOutput = await submitStoredEnvelope(remote, outbox);
      vault.commitOutbox(logicalId, output.message.envelope.header.expires_at, verificationMode);
      return { content: input.content, output, verificationMode };
    } catch (error: unknown) {
      if (!(error instanceof EncryptionClaimExpiredError)) throw error;
      outbox = vault.replaceExpiredOutboxClaim(logicalId, clock.now().toISOString());
    }
  }
  throw new Error("Encryption claim repeatedly expired; retry the send operation");
}
