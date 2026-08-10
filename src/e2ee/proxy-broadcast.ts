import sodium from "libsodium-wrappers";

import type { Clock, Instant } from "../domain/value-objects.js";
import { ordinaryClaimedProvenance } from "./claimed-provenance.js";
import { BinaryWriter } from "./encoding.js";
import { encryptEnvelope } from "./envelope.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { OutboxItem, SentReceipt } from "./local-vault-rows.js";
import {
  getE2eeCapability,
  type LocalPublishedIdentity,
  publishLocalIdentity,
  type VerifiedClaim,
  verifyClaimedPeer,
} from "./proxy-identity.js";
import {
  claimProvenanceMatches,
  defaultProxySendOptions,
  envelopeExpiry,
  type ProxySendOptions,
} from "./proxy-send.js";
import { type E2eeRemoteClient, EncryptionClaimExpiredError } from "./remote-client.js";
import { envelopeToDto, parseSerializedEnvelope, serializeEnvelope } from "./wire-contracts.js";
import {
  type CommitEncryptedBroadcastOutput,
  CommitEncryptedBroadcastOutputSchema,
  type E2eeCapabilityOutput,
  type E2eeMessageContextDto,
  type EncryptedBroadcastAudienceDto,
  type EncryptedBroadcastClaimDto,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
  type PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedBroadcastDeliveryOutputSchema,
} from "./wire-tools.js";

const MAX_BROADCAST_ATTEMPTS: number = 2;
const DELIVERY_ID_DOMAIN: string = "murmur-e2ee-v1/broadcast-delivery-id";
const DIGEST_DOMAIN: string = "murmur-e2ee-v1/broadcast-outbox-digest";

export type ProxyBroadcastInput = {
  readonly audience: EncryptedBroadcastAudienceDto;
  readonly content: string;
  readonly context: E2eeMessageContextDto;
  readonly idempotencyKey: string | null;
  readonly senderId: string;
  readonly sessionKey?: string | undefined;
  readonly threadId: string | null;
};

export type BroadcastRecipientVerification = {
  readonly recipientId: string;
  readonly verificationMode: "organization" | "strict" | "tofu";
};

export type ProxyBroadcastResult = {
  readonly content: string;
  readonly output: CommitEncryptedBroadcastOutput;
  readonly prepared: PrepareEncryptedBroadcastOutput;
  readonly recipients: readonly BroadcastRecipientVerification[];
};

export type ProxyBroadcastOptions = ProxySendOptions;

type BroadcastDelivery = {
  readonly claim: EncryptedBroadcastClaimDto;
  readonly envelopeJson: string;
  readonly logicalId: string;
  readonly receipt: SentReceipt | null;
  readonly verificationMode: "organization" | "strict" | "tofu";
};

function nullableAudience(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function deliveryLogicalId(broadcastLogicalId: string, recipientId: string): string {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(DELIVERY_ID_DOMAIN);
  writer.writeString(broadcastLogicalId);
  writer.writeString(recipientId);
  const canonical: Uint8Array = writer.finish();
  try {
    const digest: Uint8Array = sodium.crypto_generichash(32, canonical, null);
    return `eb_${Buffer.from(digest).toString("base64url")}`;
  } finally {
    sodium.memzero(canonical);
  }
}

function broadcastDigest(
  rootPrivateKey: Uint8Array,
  broadcastLogicalId: string,
  recipientId: string,
  input: ProxyBroadcastInput,
): Uint8Array {
  const writer: BinaryWriter = new BinaryWriter();
  writer.writeString(DIGEST_DOMAIN);
  writer.writeString(broadcastLogicalId);
  writer.writeString(input.senderId);
  writer.writeString(recipientId);
  writer.writeNullableString(input.threadId);
  writer.writeNullableString(nullableAudience(input.audience.machine));
  writer.writeNullableString(nullableAudience(input.audience.repository));
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

function matchingReceipt(
  receipt: SentReceipt,
  tenantId: string,
  senderId: string,
  recipientId: string,
  digest: Uint8Array,
  prepared: PrepareEncryptedBroadcastOutput,
): BroadcastDelivery {
  if (
    receipt.tenantId !== tenantId ||
    receipt.senderId !== senderId ||
    receipt.recipientId !== recipientId ||
    !sodium.memcmp(receipt.plaintextDigest, digest)
  ) {
    throw new Error("Encrypted broadcast receipt idempotency conflict");
  }
  const envelope: ReturnType<typeof parseSerializedEnvelope> = parseSerializedEnvelope(
    receipt.envelopeJson,
  );
  if (
    envelope.header.broadcastId !== prepared.broadcast_id ||
    envelope.header.threadId !== prepared.thread_id ||
    envelope.header.recipientId !== recipientId
  ) {
    throw new Error("Encrypted broadcast receipt does not match its hosted snapshot");
  }
  const claim: EncryptedBroadcastClaimDto | undefined = prepared.claims.find(
    (candidate: EncryptedBroadcastClaimDto): boolean => candidate.recipient_id === recipientId,
  );
  if (claim === undefined || receipt.claimId !== claim.claim_id) {
    throw new Error("Encrypted broadcast claim changed after commit");
  }
  return {
    claim,
    envelopeJson: receipt.envelopeJson,
    logicalId: receipt.logicalId,
    receipt,
    verificationMode: receipt.verificationMode,
  };
}

async function createDelivery(
  vault: LocalE2eeVault,
  identity: LocalPublishedIdentity,
  capability: E2eeCapabilityOutput,
  prepared: PrepareEncryptedBroadcastOutput,
  input: ProxyBroadcastInput,
  broadcastLogicalId: string,
  claim: EncryptedBroadcastClaimDto,
  now: Instant,
  options: ProxyBroadcastOptions,
): Promise<BroadcastDelivery> {
  const verified: VerifiedClaim = await verifyClaimedPeer(
    vault,
    claim,
    claim.recipient_id,
    capability.tenant_id,
    now,
    options.trustOnFirstUse,
  );
  const expectedProvenance: EncryptedBroadcastClaimDto["provenance"] =
    options.expectedProvenance ?? ordinaryClaimedProvenance(capability.caller_authority);
  if (!claimProvenanceMatches(verified.claim.provenance, expectedProvenance)) {
    throw new Error("Hosted Murmur returned unexpected broadcast sender provenance");
  }
  const logicalId: string = deliveryLogicalId(broadcastLogicalId, claim.recipient_id);
  const digest: Uint8Array = broadcastDigest(
    identity.root.privateKey,
    broadcastLogicalId,
    claim.recipient_id,
    input,
  );
  const receipt: SentReceipt | null = vault.getSentReceipt(logicalId);
  if (receipt !== null) {
    return matchingReceipt(
      receipt,
      capability.tenant_id,
      input.senderId,
      claim.recipient_id,
      digest,
      prepared,
    );
  }
  let outbox: OutboxItem = vault.beginOutbox({
    createdAt: now.toISOString(),
    logicalId,
    plaintext: input.content,
    plaintextDigest: digest,
    recipientId: claim.recipient_id,
    senderId: input.senderId,
    tenantId: capability.tenant_id,
    threadId: prepared.thread_id,
  });
  if (outbox.claimId === null && outbox.envelopeJson === null) {
    const envelope: Awaited<ReturnType<typeof encryptEnvelope>> = await encryptEnvelope(
      {
        branchName: input.context.branch,
        broadcastId: prepared.broadcast_id,
        client: input.context.client,
        createdAt: now.toISOString(),
        expiresAt: envelopeExpiry(now, identity, verified),
        idempotencyKey: logicalId,
        messageId: options.uuid(),
        messageKind: verified.claim.provenance.message_kind,
        orchestratorPolicyId: verified.claim.provenance.orchestrator_policy_id,
        pairCounter: outbox.pairCounter,
        recipientAgentKeyId: verified.recipient.agentCertificate.signingKeyId,
        recipientId: claim.recipient_id,
        recipientPrekeyClass: verified.prekey.prekeyClass,
        recipientPrekeyId: verified.prekey.prekeyId,
        recipientRootKeyId: verified.recipient.rootKeyId,
        repositoryName: input.context.repository,
        senderAgentKeyId: identity.agent.certificate.signingKeyId,
        senderAuthority: verified.claim.provenance.sender_authority,
        senderId: input.senderId,
        senderRootKeyId: identity.root.rootKeyId,
        tenantId: capability.tenant_id,
        threadId: prepared.thread_id,
      },
      input.content,
      identity.agent.privateKey,
      verified.prekey.prekeyPublicKey,
      options.random,
    );
    if (envelope.ciphertext.byteLength > capability.max_ciphertext_bytes) {
      throw new Error("Encrypted broadcast delivery exceeds the hosted ciphertext limit");
    }
    outbox = vault.setOutboxEnvelope(logicalId, claim.claim_id, serializeEnvelope(envelope));
  }
  if (outbox.claimId !== claim.claim_id || outbox.envelopeJson === null) {
    throw new Error("Encrypted broadcast outbox does not match its hosted claim");
  }
  const storedEnvelope: ReturnType<typeof parseSerializedEnvelope> = parseSerializedEnvelope(
    outbox.envelopeJson,
  );
  if (
    storedEnvelope.header.broadcastId !== prepared.broadcast_id ||
    storedEnvelope.header.threadId !== prepared.thread_id
  ) {
    throw new Error("Encrypted broadcast outbox does not match its hosted snapshot");
  }
  return {
    claim,
    envelopeJson: outbox.envelopeJson,
    logicalId,
    receipt: null,
    verificationMode: verified.verificationMode,
  };
}

async function cancelPrepared(
  remote: E2eeRemoteClient,
  prepared: PrepareEncryptedBroadcastOutput,
): Promise<void> {
  try {
    await remote.cancelEncryptedBroadcast({ broadcast_id: prepared.broadcast_id });
  } catch (_error: unknown) {
    throw new Error("Encrypted broadcast pending-state cleanup failed; retry the same operation");
  }
}

async function submitDelivery(
  remote: E2eeRemoteClient,
  prepared: PrepareEncryptedBroadcastOutput,
  delivery: BroadcastDelivery,
): Promise<void> {
  const output: PutEncryptedBroadcastDeliveryOutput =
    PutEncryptedBroadcastDeliveryOutputSchema.parse(
      await remote.putEncryptedBroadcastDelivery({
        broadcast_id: prepared.broadcast_id,
        claim_id: delivery.claim.claim_id,
        envelope: envelopeToDto(parseSerializedEnvelope(delivery.envelopeJson)),
      }),
    );
  if (!output.accepted || output.recipient_id !== delivery.claim.recipient_id) {
    throw new Error("Hosted Murmur returned an inconsistent broadcast delivery acknowledgement");
  }
}

function resetExpiredDeliveries(
  vault: LocalE2eeVault,
  deliveries: readonly BroadcastDelivery[],
  now: Instant,
): void {
  deliveries.forEach((delivery: BroadcastDelivery): void => {
    if (delivery.receipt === null) {
      vault.replaceExpiredOutboxClaim(delivery.logicalId, now.toISOString());
    }
  });
}

export async function broadcastEncryptedMessage(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  clock: Clock,
  input: ProxyBroadcastInput,
  options: ProxyBroadcastOptions = defaultProxySendOptions(),
): Promise<ProxyBroadcastResult> {
  await sodium.ready;
  const capability: E2eeCapabilityOutput = await getE2eeCapability(remote, false);
  const identity: LocalPublishedIdentity = await publishLocalIdentity(
    vault,
    remote,
    input.senderId,
    clock.now(),
    input.sessionKey,
  );
  const broadcastLogicalId: string =
    input.idempotencyKey === null ? options.uuid() : input.idempotencyKey;
  for (let attempt: number = 0; attempt < MAX_BROADCAST_ATTEMPTS; attempt += 1) {
    const now: Instant = clock.now();
    const prepared: PrepareEncryptedBroadcastOutput = PrepareEncryptedBroadcastOutputSchema.parse(
      await remote.prepareEncryptedBroadcast({
        audience: input.audience,
        context: input.context,
        idempotency_key: broadcastLogicalId,
        sender_id: input.senderId,
        ...(input.sessionKey === undefined ? {} : { session_key: input.sessionKey }),
        thread_id: input.threadId === null ? undefined : input.threadId,
      }),
    );
    if (input.threadId !== null && prepared.thread_id !== input.threadId) {
      await cancelPrepared(remote, prepared);
      throw new Error("Hosted Murmur changed the encrypted broadcast thread");
    }
    let deliveries: readonly BroadcastDelivery[];
    try {
      const built: BroadcastDelivery[] = [];
      for (const claim of prepared.claims) {
        built.push(
          await createDelivery(
            vault,
            identity,
            capability,
            prepared,
            input,
            broadcastLogicalId,
            claim,
            now,
            options,
          ),
        );
      }
      deliveries = built;
    } catch (error: unknown) {
      await cancelPrepared(remote, prepared);
      throw error;
    }
    try {
      for (const delivery of deliveries) await submitDelivery(remote, prepared, delivery);
      const output: CommitEncryptedBroadcastOutput = CommitEncryptedBroadcastOutputSchema.parse(
        await remote.commitEncryptedBroadcast({ broadcast_id: prepared.broadcast_id }),
      );
      if (
        output.broadcast_id !== prepared.broadcast_id ||
        output.recipient_count !== prepared.recipient_count
      ) {
        throw new Error("Hosted Murmur returned an inconsistent broadcast commit acknowledgement");
      }
      deliveries.forEach((delivery: BroadcastDelivery): void => {
        if (delivery.receipt === null) {
          const envelope: ReturnType<typeof parseSerializedEnvelope> = parseSerializedEnvelope(
            delivery.envelopeJson,
          );
          vault.commitOutbox(
            delivery.logicalId,
            envelope.header.expiresAt,
            delivery.verificationMode,
          );
        }
      });
      return {
        content: input.content,
        output,
        prepared,
        recipients: deliveries.map(
          (delivery: BroadcastDelivery): BroadcastRecipientVerification => ({
            recipientId: delivery.claim.recipient_id,
            verificationMode: delivery.verificationMode,
          }),
        ),
      };
    } catch (error: unknown) {
      if (!(error instanceof EncryptionClaimExpiredError)) throw error;
      await cancelPrepared(remote, prepared);
      resetExpiredDeliveries(vault, deliveries, clock.now());
    }
  }
  throw new Error("Encryption claims repeatedly expired; retry the broadcast operation");
}
