import sodium from "libsodium-wrappers";

import type { Instant } from "../domain/value-objects.js";
import {
  type PrekeyCertificate,
  verifyAgentKeyCertificate,
  verifyPrekeyCertificate,
} from "./certificates.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type {
  ExpectedPeerRoot,
  PeerPin,
  StoredAgentKey,
  StoredPrekey,
  StoredRootKey,
} from "./local-vault-rows.js";
import type { E2eeRemoteClient } from "./remote-client.js";
import {
  type PublicAgentKeyBundle,
  parsePublicBundleDto,
  publicBundleToDto,
} from "./wire-contracts.js";
import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityOutputSchema,
  type PublishAgentKeyBundleOutput,
  PublishAgentKeyBundleOutputSchema,
} from "./wire-tools.js";

const AGENT_KEY_DAYS: number = 90;
const PREKEY_DAYS: number = 37;
const ONE_TIME_PREKEY_TARGET: number = 20;
const MAX_CLAIM_TTL_MS: number = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS: number = 5 * 60 * 1000;

export type LocalPublishedIdentity = {
  readonly agent: StoredAgentKey;
  readonly fallback: StoredPrekey;
  readonly oneTimePrekeys: readonly StoredPrekey[];
  readonly root: StoredRootKey;
};

export type VerifiedClaim = {
  readonly claim: ClaimEncryptionPrekeyOutput;
  readonly prekey: PrekeyCertificate;
  readonly recipient: PublicAgentKeyBundle;
  readonly verificationMode: "organization" | "strict" | "tofu";
};

function availablePrekeys(
  vault: LocalE2eeVault,
  agentId: string,
  agentSigningKeyId: string,
  prekeyClass: "fallback" | "one_time",
  now: Instant,
): readonly StoredPrekey[] {
  const nowMillis: number = now.toEpochMilliseconds();
  return vault.keys
    .listPrekeys(agentId, prekeyClass)
    .filter(
      (prekey: StoredPrekey): boolean =>
        prekey.privateKey !== null &&
        prekey.certificate.agentSigningKeyId === agentSigningKeyId &&
        Date.parse(prekey.certificate.expiresAt) > nowMillis,
    );
}

function requireCapability(input: unknown, allowProvisioning: boolean): E2eeCapabilityOutput {
  const capability: E2eeCapabilityOutput = E2eeCapabilityOutputSchema.parse(input);
  if (capability.state === "off" || (!allowProvisioning && capability.state !== "enforced")) {
    throw new Error(
      "Murmur E2E is not enforced for this tenant. Complete tenant provisioning, then retry.",
    );
  }
  return capability;
}

export async function getE2eeCapability(
  remote: E2eeRemoteClient,
  allowProvisioning: boolean,
): Promise<E2eeCapabilityOutput> {
  return requireCapability(await remote.capability(), allowProvisioning);
}

export async function publishLocalIdentity(
  vault: LocalE2eeVault,
  remote: E2eeRemoteClient,
  agentId: string,
  now: Instant,
): Promise<LocalPublishedIdentity> {
  await getE2eeCapability(remote, true);
  const agent: StoredAgentKey = await vault.keys.getOrCreateAgent(
    agentId,
    now.toISOString(),
    now.addDays(AGENT_KEY_DAYS).toISOString(),
  );
  let fallbackKeys: readonly StoredPrekey[] = availablePrekeys(
    vault,
    agentId,
    agent.certificate.signingKeyId,
    "fallback",
    now,
  );
  if (fallbackKeys.length === 0) {
    fallbackKeys = await vault.keys.replenishPrekeys(
      agentId,
      "fallback",
      1,
      now.toISOString(),
      now.addDays(PREKEY_DAYS).toISOString(),
    );
  }
  let oneTimePrekeys: readonly StoredPrekey[] = availablePrekeys(
    vault,
    agentId,
    agent.certificate.signingKeyId,
    "one_time",
    now,
  );
  if (oneTimePrekeys.length < ONE_TIME_PREKEY_TARGET) {
    await vault.keys.replenishPrekeys(
      agentId,
      "one_time",
      ONE_TIME_PREKEY_TARGET - oneTimePrekeys.length,
      now.toISOString(),
      now.addDays(PREKEY_DAYS).toISOString(),
    );
    oneTimePrekeys = availablePrekeys(
      vault,
      agentId,
      agent.certificate.signingKeyId,
      "one_time",
      now,
    );
  }
  const fallback: StoredPrekey | undefined = fallbackKeys[0];
  const root: StoredRootKey | null = vault.keys.getRoot();
  if (fallback === undefined || root === null) throw new Error("Local E2E identity is unavailable");
  const published: PublishAgentKeyBundleOutput = PublishAgentKeyBundleOutputSchema.parse(
    await remote.publishAgentKeyBundle({
      agent_id: agentId,
      bundle: publicBundleToDto(
        root.publicKey,
        agent.certificate,
        fallback.certificate,
        oneTimePrekeys.map((prekey: StoredPrekey): PrekeyCertificate => prekey.certificate),
      ),
    }),
  );
  if (
    published.agent_id !== agentId ||
    published.root_key_id !== root.rootKeyId ||
    published.fallback_prekey_id !== fallback.certificate.prekeyId ||
    published.one_time_prekey_count !== oneTimePrekeys.length
  ) {
    throw new Error("Hosted Murmur returned an inconsistent E2E identity acknowledgement");
  }
  return { agent, fallback, oneTimePrekeys, root };
}

function selectedPrekey(
  bundle: PublicAgentKeyBundle,
  claim: ClaimEncryptionPrekeyOutput,
): PrekeyCertificate {
  if (claim.prekey_class === "fallback") return bundle.fallbackPrekey;
  const selected: PrekeyCertificate | undefined = bundle.oneTimePrekeys.find(
    (prekey: PrekeyCertificate): boolean => prekey.prekeyId === claim.prekey_id,
  );
  if (selected === undefined) throw new Error("Claimed recipient prekey is unavailable");
  return selected;
}

function validateClaimWindow(claim: ClaimEncryptionPrekeyOutput, now: Instant): void {
  const claimedAt: number = Date.parse(claim.claimed_at);
  const expiresAt: number = Date.parse(claim.expires_at);
  const nowMillis: number = now.toEpochMilliseconds();
  if (
    !Number.isFinite(claimedAt) ||
    !Number.isFinite(expiresAt) ||
    claimedAt > nowMillis + MAX_CLOCK_SKEW_MS ||
    expiresAt <= nowMillis ||
    expiresAt - claimedAt > MAX_CLAIM_TTL_MS
  ) {
    throw new Error("Hosted Murmur returned an invalid encryption claim window");
  }
}

export async function verifyClaimedPeer(
  vault: LocalE2eeVault,
  input: unknown,
  expectedRecipientId: string,
  tenantId: string,
  now: Instant,
  trustOnFirstUse: boolean,
): Promise<VerifiedClaim> {
  await sodium.ready;
  const claim: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(input);
  if (claim.recipient_id !== expectedRecipientId) {
    throw new Error("Hosted Murmur changed the encryption claim recipient");
  }
  validateClaimWindow(claim, now);
  const recipient: PublicAgentKeyBundle = parsePublicBundleDto(claim.bundle);
  await verifyAgentKeyCertificate(
    recipient.agentCertificate,
    recipient.rootPublicKey,
    expectedRecipientId,
    new Date(now.toISOString()),
  );
  const prekey: PrekeyCertificate = selectedPrekey(recipient, claim);
  await verifyPrekeyCertificate(
    prekey,
    recipient.agentCertificate,
    expectedRecipientId,
    new Date(now.toISOString()),
  );
  let pin: PeerPin | null = vault.keys.getUsablePin(
    tenantId,
    expectedRecipientId,
    new Date(now.toISOString()),
  );
  if (pin === null) {
    const expected: ExpectedPeerRoot | null = vault.keys.getExpectedPeerRoot(
      tenantId,
      expectedRecipientId,
    );
    if (expected !== null && expected.rootKeyId !== recipient.rootKeyId) {
      throw new Error("Recipient root does not match its verified fingerprint");
    }
    if (expected === null && !trustOnFirstUse) {
      throw new Error(
        `Recipient '${expectedRecipientId}' is not trusted. Verify its full root fingerprint, then run murmur e2ee trust.`,
      );
    }
    pin = await vault.keys.pinPeer({
      agentId: expectedRecipientId,
      publicKey: recipient.rootPublicKey,
      rootKeyId: recipient.rootKeyId,
      tenantId,
      verificationMode: expected === null ? "tofu" : "strict",
      verifiedAt: now.toISOString(),
    });
  }
  if (
    pin.rootKeyId !== recipient.rootKeyId ||
    !sodium.memcmp(pin.publicKey, recipient.rootPublicKey)
  ) {
    throw new Error("Recipient root changed and requires an audited trust reset");
  }
  return { claim, prekey, recipient, verificationMode: pin.verificationMode };
}
