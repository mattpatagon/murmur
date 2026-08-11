import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  decryptCanaryE2eeMessage,
  encryptCanaryE2eeMessage,
} from "../../scripts/lib/e2ee-canary-crypto.js";
import {
  type AgentKeyCertificate,
  type AgentKeyRevocation,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createAgentKeyRevocation,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  prekeyId,
} from "../../src/e2ee/certificates.js";
import type { BoxKeyPair, SigningKeyPair } from "../../src/e2ee/protocol.js";
import { type PublicAgentKeyBundleDto, publicBundleToDto } from "../../src/e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyOutput,
  EncryptedMessageDto,
  PutEncryptedMessageInput,
} from "../../src/e2ee/wire-tools.js";

export type TestE2eeIdentity = CanaryE2eeIdentity;

export async function createTestE2eeIdentity(
  agentId: string,
  now: Date,
): Promise<TestE2eeIdentity> {
  return await createCanaryE2eeIdentity(agentId, now);
}

export function testE2eeBundle(identity: TestE2eeIdentity): PublicAgentKeyBundleDto {
  return canaryE2eeBundle(identity);
}

export async function testE2eeBundleWithRevokedAgentKey(
  identity: TestE2eeIdentity,
  agentId: string,
  now: Date,
): Promise<PublicAgentKeyBundleDto> {
  const replacement: SigningKeyPair = await createSigningKeyPair(null);
  const replacementSigningKeyId: string = await agentSigningKeyId(replacement.publicKey);
  const createdAt: string = new Date(now.getTime() - 30 * 60 * 1_000).toISOString();
  const replacementCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId,
      createdAt,
      expiresAt: new Date(now.getTime() + 80 * 24 * 60 * 60 * 1_000).toISOString(),
      rootKeyId: identity.agentCertificate.rootKeyId,
      signingKeyId: replacementSigningKeyId,
      signingPublicKey: replacement.publicKey,
    },
    identity.root.privateKey,
  );
  const fallback: BoxKeyPair = await createBoxKeyPair(null);
  const fallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: replacementSigningKeyId,
      createdAt,
      expiresAt: new Date(now.getTime() + 40 * 24 * 60 * 60 * 1_000).toISOString(),
      prekeyClass: "fallback",
      prekeyId: await prekeyId(fallback.publicKey),
      prekeyPublicKey: fallback.publicKey,
    },
    replacement.privateKey,
  );
  const revocation: AgentKeyRevocation = await createAgentKeyRevocation(
    {
      agentId,
      reason: "Security regression revocation",
      revokedAt: now.toISOString(),
      revokedSigningKeyId: identity.agentCertificate.signingKeyId,
      rootKeyId: identity.agentCertificate.rootKeyId,
    },
    identity.root.privateKey,
  );
  return publicBundleToDto(
    identity.root.publicKey,
    replacementCertificate,
    fallbackCertificate,
    [],
    [revocation],
  );
}

export async function encryptTestE2eeMessage(input: {
  readonly branch: string;
  readonly claim: ClaimEncryptionPrekeyOutput;
  readonly idempotencyKey: string;
  readonly pairCounter: number;
  readonly plaintext: string;
  readonly recipient: TestE2eeIdentity;
  readonly repository: string;
  readonly sender: TestE2eeIdentity;
  readonly senderId: string;
  readonly tenantId: string;
}): Promise<PutEncryptedMessageInput> {
  return await encryptCanaryE2eeMessage(input);
}

export async function decryptTestE2eeMessage(
  message: EncryptedMessageDto,
  sender: TestE2eeIdentity,
  recipient: TestE2eeIdentity,
): Promise<string> {
  return await decryptCanaryE2eeMessage(message, sender, recipient);
}
