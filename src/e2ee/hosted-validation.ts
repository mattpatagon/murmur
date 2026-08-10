import {
  verifyAgentKeyCertificate,
  verifyAgentKeyRevocation,
  verifyPrekeyCertificate,
} from "./certificates.js";
import { verifyEnvelopeSignature } from "./envelope.js";
import type { EncryptedEnvelope } from "./protocol.js";
import {
  type PublicAgentKeyBundle,
  type PublicAgentSigningChain,
  parseEnvelopeDto,
  parsePublicBundleDto,
  parseSigningChainDto,
} from "./wire-contracts.js";
import {
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type PutEncryptedMessageInput,
  PutEncryptedMessageInputSchema,
} from "./wire-tools.js";

const MAX_CLOCK_SKEW_MS: number = 5 * 60 * 1_000;
const MAX_CLAIM_TTL_MS: number = 5 * 60 * 1_000;
const MAX_RETENTION_MS: number = 30 * 24 * 60 * 60 * 1_000;

export type HostedClaimValidationInput = {
  readonly claimInput: ClaimEncryptionPrekeyInput;
  readonly claimOutput: ClaimEncryptionPrekeyOutput;
  readonly now: Date;
};

export type HostedEnvelopeValidationInput = HostedClaimValidationInput & {
  readonly expectedBroadcastId: string | null;
  readonly maxCiphertextBytes: number;
  readonly putInput: PutEncryptedMessageInput;
  readonly senderChain: unknown;
  readonly tenantId: string;
};

function validInstant(value: string): number {
  const millis: number = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("invalid instant");
  return millis;
}

function verifyClaimWindow(claim: ClaimEncryptionPrekeyOutput, now: Date): void {
  const claimedAt: number = validInstant(claim.claimed_at);
  const expiresAt: number = validInstant(claim.expires_at);
  const nowMillis: number = now.getTime();
  if (
    claimedAt > nowMillis + MAX_CLOCK_SKEW_MS ||
    expiresAt <= nowMillis ||
    expiresAt <= claimedAt ||
    expiresAt - claimedAt > MAX_CLAIM_TTL_MS
  ) {
    throw new Error("invalid claim window");
  }
}

async function verifyRevocations(
  chain: PublicAgentSigningChain,
  agentId: string,
  now: Date,
): Promise<void> {
  for (const revocation of chain.agentKeyRevocations) {
    await verifyAgentKeyRevocation(revocation, chain.rootPublicKey, agentId, now);
  }
}

export async function verifyHostedPublicBundle(
  agentId: string,
  input: unknown,
  now: Date,
  maxOneTimePrekeys: number,
): Promise<PublicAgentKeyBundle> {
  try {
    const bundle: PublicAgentKeyBundle = parsePublicBundleDto(input);
    if (bundle.oneTimePrekeys.length > maxOneTimePrekeys) throw new Error("prekey count");
    await verifyAgentKeyCertificate(bundle.agentCertificate, bundle.rootPublicKey, agentId, now);
    await verifyRevocations(bundle, agentId, now);
    await verifyPrekeyCertificate(bundle.fallbackPrekey, bundle.agentCertificate, agentId, now);
    for (const prekey of bundle.oneTimePrekeys) {
      await verifyPrekeyCertificate(prekey, bundle.agentCertificate, agentId, now);
    }
    return bundle;
  } catch (_error: unknown) {
    throw new Error("Published E2E key bundle validation failed");
  }
}

export async function verifyHostedClaim(
  input: HostedClaimValidationInput,
): Promise<PublicAgentKeyBundle> {
  try {
    const request: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse(
      input.claimInput,
    );
    const claim: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
      input.claimOutput,
    );
    if (claim.recipient_id !== request.recipient_id) throw new Error("recipient");
    verifyClaimWindow(claim, input.now);
    return await verifyHostedPublicBundle(
      request.recipient_id,
      claim.bundle,
      input.now,
      claim.bundle.one_time_prekeys.length,
    );
  } catch (_error: unknown) {
    throw new Error("Encryption prekey claim validation failed");
  }
}

function selectedPrekey(
  bundle: PublicAgentKeyBundle,
  claim: ClaimEncryptionPrekeyOutput,
): PublicAgentKeyBundle["fallbackPrekey"] {
  if (claim.prekey_class === "fallback") return bundle.fallbackPrekey;
  const selected: PublicAgentKeyBundle["oneTimePrekeys"][number] | undefined =
    bundle.oneTimePrekeys.find(
      (prekey: PublicAgentKeyBundle["oneTimePrekeys"][number]): boolean =>
        prekey.prekeyId === claim.prekey_id,
    );
  if (selected === undefined) throw new Error("claimed prekey");
  return selected;
}

function verifyEnvelopeWindow(envelope: EncryptedEnvelope, now: Date): void {
  const createdAt: number = validInstant(envelope.header.createdAt);
  const expiresAt: number = validInstant(envelope.header.expiresAt);
  const nowMillis: number = now.getTime();
  if (
    createdAt < nowMillis - MAX_CLOCK_SKEW_MS ||
    createdAt > nowMillis + MAX_CLOCK_SKEW_MS ||
    expiresAt <= createdAt ||
    expiresAt <= nowMillis ||
    expiresAt > nowMillis + MAX_RETENTION_MS
  ) {
    throw new Error("envelope window");
  }
}

function contextMatches(envelope: EncryptedEnvelope, request: ClaimEncryptionPrekeyInput): boolean {
  return (
    envelope.header.repositoryName === request.context.repository &&
    envelope.header.branchName === request.context.branch &&
    envelope.header.client === request.context.client
  );
}

function provenanceMatches(
  envelope: EncryptedEnvelope,
  claim: ClaimEncryptionPrekeyOutput,
): boolean {
  return (
    envelope.header.senderAuthority === claim.provenance.sender_authority &&
    envelope.header.messageKind === claim.provenance.message_kind &&
    envelope.header.orchestratorPolicyId === claim.provenance.orchestrator_policy_id
  );
}

function deliveryMatches(
  input: HostedEnvelopeValidationInput,
  envelope: EncryptedEnvelope,
  recipient: PublicAgentKeyBundle,
  sender: PublicAgentSigningChain,
): boolean {
  const request: ClaimEncryptionPrekeyInput = input.claimInput;
  const claim: ClaimEncryptionPrekeyOutput = input.claimOutput;
  const prekey: PublicAgentKeyBundle["fallbackPrekey"] = selectedPrekey(recipient, claim);
  return (
    input.putInput.claim_id === claim.claim_id &&
    envelope.header.tenantId === input.tenantId &&
    envelope.header.senderId === request.sender_id &&
    envelope.header.recipientId === request.recipient_id &&
    envelope.header.broadcastId === input.expectedBroadcastId &&
    contextMatches(envelope, request) &&
    provenanceMatches(envelope, claim) &&
    envelope.header.recipientRootKeyId === recipient.rootKeyId &&
    envelope.header.recipientAgentKeyId === recipient.agentCertificate.signingKeyId &&
    envelope.header.recipientPrekeyId === prekey.prekeyId &&
    envelope.header.recipientPrekeyClass === prekey.prekeyClass &&
    envelope.header.senderRootKeyId === sender.rootKeyId &&
    envelope.header.senderAgentKeyId === sender.agentCertificate.signingKeyId &&
    sender.agentCertificate.agentId === request.sender_id
  );
}

function withinKeyWindows(
  envelope: EncryptedEnvelope,
  recipient: PublicAgentKeyBundle,
  claim: ClaimEncryptionPrekeyOutput,
  sender: PublicAgentSigningChain,
): boolean {
  const expiresAt: number = validInstant(envelope.header.expiresAt);
  const prekey: PublicAgentKeyBundle["fallbackPrekey"] = selectedPrekey(recipient, claim);
  return (
    expiresAt <= validInstant(recipient.agentCertificate.expiresAt) &&
    expiresAt <= validInstant(prekey.expiresAt) &&
    expiresAt <= validInstant(sender.agentCertificate.expiresAt)
  );
}

export async function verifyHostedEncryptedEnvelope(
  input: HostedEnvelopeValidationInput,
): Promise<EncryptedEnvelope> {
  try {
    const request: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse(
      input.claimInput,
    );
    const claim: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
      input.claimOutput,
    );
    const put: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse(input.putInput);
    const envelope: EncryptedEnvelope = parseEnvelopeDto(put.envelope);
    if (envelope.ciphertext.byteLength > input.maxCiphertextBytes) throw new Error("ciphertext");
    const recipient: PublicAgentKeyBundle = await verifyHostedClaim({
      claimInput: request,
      claimOutput: claim,
      now: input.now,
    });
    const sender: PublicAgentSigningChain = parseSigningChainDto(input.senderChain);
    await verifyAgentKeyCertificate(
      sender.agentCertificate,
      sender.rootPublicKey,
      request.sender_id,
      input.now,
    );
    await verifyRevocations(sender, request.sender_id, input.now);
    verifyEnvelopeWindow(envelope, input.now);
    if (
      !deliveryMatches(
        { ...input, claimInput: request, claimOutput: claim, putInput: put },
        envelope,
        recipient,
        sender,
      )
    ) {
      throw new Error("delivery binding");
    }
    if (!withinKeyWindows(envelope, recipient, claim, sender)) throw new Error("key window");
    await verifyEnvelopeSignature(envelope, sender.agentCertificate.signingPublicKey);
    return envelope;
  } catch (_error: unknown) {
    throw new Error("Hosted encrypted message validation failed");
  }
}
