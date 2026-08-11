import { randomUUID } from "node:crypto";

import {
  type AgentKeyCertificate,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  prekeyId,
  rootKeyId,
} from "../../src/e2ee/certificates.js";
import { decryptEnvelope, encryptEnvelope } from "../../src/e2ee/envelope.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeaderInput,
  SigningKeyPair,
} from "../../src/e2ee/protocol.js";
import {
  envelopeToDto,
  parseEnvelopeDto,
  publicBundleToDto,
} from "../../src/e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyOutput,
  EncryptedMessageDto,
  PutEncryptedMessageInput,
} from "../../src/e2ee/wire-tools.js";

export type CanaryE2eeIdentity = {
  readonly agent: SigningKeyPair;
  readonly agentCertificate: AgentKeyCertificate;
  readonly fallback: BoxKeyPair;
  readonly fallbackCertificate: PrekeyCertificate;
  readonly oneTime: BoxKeyPair;
  readonly oneTimeCertificate: PrekeyCertificate;
  readonly root: SigningKeyPair;
};

export async function createCanaryE2eeIdentity(
  agentId: string,
  now: Date,
): Promise<CanaryE2eeIdentity> {
  const root: SigningKeyPair = await createSigningKeyPair(null);
  const agent: SigningKeyPair = await createSigningKeyPair(null);
  const rootId: string = await rootKeyId(root.publicKey);
  const signingKeyId: string = await agentSigningKeyId(agent.publicKey);
  const createdAt: string = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
  const keyExpires: string = new Date(now.getTime() + 40 * 24 * 60 * 60 * 1_000).toISOString();
  const agentExpires: string = new Date(now.getTime() + 80 * 24 * 60 * 60 * 1_000).toISOString();
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId,
      createdAt,
      expiresAt: agentExpires,
      rootKeyId: rootId,
      signingKeyId,
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
  const fallback: BoxKeyPair = await createBoxKeyPair(null);
  const oneTime: BoxKeyPair = await createBoxKeyPair(null);
  const fallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt,
      expiresAt: keyExpires,
      prekeyClass: "fallback",
      prekeyId: await prekeyId(fallback.publicKey),
      prekeyPublicKey: fallback.publicKey,
    },
    agent.privateKey,
  );
  const oneTimeCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt,
      expiresAt: keyExpires,
      prekeyClass: "one_time",
      prekeyId: await prekeyId(oneTime.publicKey),
      prekeyPublicKey: oneTime.publicKey,
    },
    agent.privateKey,
  );
  return {
    agent,
    agentCertificate,
    fallback,
    fallbackCertificate,
    oneTime,
    oneTimeCertificate,
    root,
  };
}

export function canaryE2eeBundle(
  identity: CanaryE2eeIdentity,
): ReturnType<typeof publicBundleToDto> {
  return publicBundleToDto(
    identity.root.publicKey,
    identity.agentCertificate,
    identity.fallbackCertificate,
    [identity.oneTimeCertificate],
  );
}

function recipientPublicKey(
  recipient: CanaryE2eeIdentity,
  claim: ClaimEncryptionPrekeyOutput,
): Uint8Array {
  return claim.prekey_class === "one_time"
    ? recipient.oneTime.publicKey
    : recipient.fallback.publicKey;
}

function recipientPrivateKey(
  recipient: CanaryE2eeIdentity,
  message: EncryptedMessageDto,
): Uint8Array {
  return message.envelope.header.recipient_prekey_class === "one_time"
    ? recipient.oneTime.privateKey
    : recipient.fallback.privateKey;
}

export async function encryptCanaryE2eeMessage(input: {
  readonly branch: string;
  readonly broadcastId?: string | undefined;
  readonly claim: ClaimEncryptionPrekeyOutput;
  readonly idempotencyKey: string;
  readonly now?: Date | undefined;
  readonly pairCounter: number;
  readonly plaintext: string;
  readonly recipient: CanaryE2eeIdentity;
  readonly repository: string;
  readonly sender: CanaryE2eeIdentity;
  readonly senderId: string;
  readonly tenantId: string;
  readonly threadId?: string | undefined;
}): Promise<PutEncryptedMessageInput> {
  const now: Date = input.now ?? new Date();
  const header: EnvelopeHeaderInput = {
    branchName: input.branch,
    broadcastId: input.broadcastId ?? null,
    client: "codex",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    idempotencyKey: input.idempotencyKey,
    messageId: randomUUID(),
    messageKind: input.claim.provenance.message_kind,
    orchestratorPolicyId: input.claim.provenance.orchestrator_policy_id,
    pairCounter: input.pairCounter,
    recipientAgentKeyId: input.recipient.agentCertificate.signingKeyId,
    recipientId: input.claim.recipient_id,
    recipientPrekeyClass: input.claim.prekey_class,
    recipientPrekeyId: input.claim.prekey_id,
    recipientRootKeyId: input.recipient.agentCertificate.rootKeyId,
    repositoryName: input.repository,
    senderAgentKeyId: input.sender.agentCertificate.signingKeyId,
    senderAuthority: input.claim.provenance.sender_authority,
    senderId: input.senderId,
    senderRootKeyId: input.sender.agentCertificate.rootKeyId,
    tenantId: input.tenantId,
    threadId: input.threadId ?? `hosted-e2ee-${input.idempotencyKey}`,
  };
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    header,
    input.plaintext,
    input.sender.agent.privateKey,
    recipientPublicKey(input.recipient, input.claim),
  );
  return { claim_id: input.claim.claim_id, envelope: envelopeToDto(envelope) };
}

export async function decryptCanaryE2eeMessage(
  message: EncryptedMessageDto,
  sender: CanaryE2eeIdentity,
  recipient: CanaryE2eeIdentity,
): Promise<string> {
  return await decryptEnvelope(
    parseEnvelopeDto(message.envelope),
    sender.agent.publicKey,
    recipientPrivateKey(recipient, message),
  );
}
