import type { Instant } from "../domain/value-objects.js";
import type { AgentKeyRevocation } from "./certificates.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type {
  ExpectedPeerRoot,
  PeerPin,
  StoredAgentKey,
  StoredPrekey,
  StoredRootKey,
} from "./local-vault-rows.js";
import type { StoredTrustPolicyState } from "./local-vault-trust.js";
import { type OrganizationTrustPolicy, parseSerializedTrustPolicy } from "./trust-policy.js";
import {
  type AgentKeyCertificateDto,
  type AgentKeyRevocationDto,
  agentCertificateToDto,
  agentKeyRevocationToDto,
  type PrekeyCertificateDto,
  prekeyCertificateToDto,
} from "./wire-contracts.js";

export type LocalPeerTrustSummary = {
  readonly agent_id: string;
  readonly root_key_id: string;
  readonly tenant_id: string;
  readonly verification: "organization" | "pending_strict" | "strict" | "tofu";
  readonly verified_at: string;
};

export type LocalE2eeStatus = {
  readonly initialized: boolean;
  readonly peer_count: number;
  readonly root_key_id: string | null;
};

export type TrustPeerFingerprintInput = {
  readonly agentId: string;
  readonly rootKeyId: string;
  readonly tenantId: string;
};

export type LocalPublicAgentIdentity = {
  readonly agent_certificate: AgentKeyCertificateDto;
  readonly agent_key_revocations: readonly AgentKeyRevocationDto[];
  readonly prekeys: readonly PrekeyCertificateDto[];
};

export type LocalPublicIdentityExport = {
  readonly agents: readonly LocalPublicAgentIdentity[];
  readonly protocol: "murmur-e2ee-v1";
  readonly root_key_id: string;
  readonly root_public_key: string;
};

export type LocalPrekeyReplenishment = {
  readonly agent_key_id: string;
  readonly fallback_available: number;
  readonly one_time_available: number;
};

export type LocalAgentKeyRevocation = {
  readonly replacement_agent_certificate: AgentKeyCertificateDto;
  readonly revocation: AgentKeyRevocationDto;
};

function pinSummary(pin: PeerPin): LocalPeerTrustSummary {
  return {
    agent_id: pin.agentId,
    root_key_id: pin.rootKeyId,
    tenant_id: pin.tenantId,
    verification: pin.verificationMode,
    verified_at: pin.verifiedAt,
  };
}

function expectationSummary(expected: ExpectedPeerRoot): LocalPeerTrustSummary {
  return {
    agent_id: expected.agentId,
    root_key_id: expected.rootKeyId,
    tenant_id: expected.tenantId,
    verification: "pending_strict",
    verified_at: expected.verifiedAt,
  };
}

export function listLocalPeerTrust(vault: LocalE2eeVault): readonly LocalPeerTrustSummary[] {
  const peers: LocalPeerTrustSummary[] = [
    ...vault.keys.listPins().map(pinSummary),
    ...vault.keys.listExpectedPeerRoots().map(expectationSummary),
  ];
  return peers.sort((left: LocalPeerTrustSummary, right: LocalPeerTrustSummary): number => {
    const tenantOrder: number = left.tenant_id.localeCompare(right.tenant_id);
    return tenantOrder === 0 ? left.agent_id.localeCompare(right.agent_id) : tenantOrder;
  });
}

export function localE2eeStatus(vault: LocalE2eeVault): LocalE2eeStatus {
  const root: StoredRootKey | null = vault.keys.getRoot();
  return {
    initialized: root !== null,
    peer_count: listLocalPeerTrust(vault).length,
    root_key_id: root === null ? null : root.rootKeyId,
  };
}

export function localE2eeFingerprint(vault: LocalE2eeVault): string {
  const root: StoredRootKey | null = vault.keys.getRoot();
  if (root === null) {
    throw new Error(
      "The local E2E identity is not initialized; use an encrypted message tool first",
    );
  }
  return root.rootKeyId;
}

export function exportLocalPublicIdentity(
  vault: LocalE2eeVault,
  agentId?: string | undefined,
): LocalPublicIdentityExport {
  const root: StoredRootKey | null = vault.keys.getRoot();
  if (root === null) {
    throw new Error("The local E2E identity is not initialized; there is no public key to export");
  }
  const agents: readonly LocalPublicAgentIdentity[] = vault.keys
    .listAgents()
    .filter(
      (agent: StoredAgentKey): boolean =>
        agentId === undefined || agent.certificate.agentId === agentId,
    )
    .map((agent: StoredAgentKey): LocalPublicAgentIdentity => {
      const prekeys: readonly StoredPrekey[] = [
        ...vault.keys.listPrekeys(agent.certificate.agentId, "fallback"),
        ...vault.keys.listPrekeys(agent.certificate.agentId, "one_time"),
      ].filter(
        (prekey: StoredPrekey): boolean =>
          prekey.certificate.agentSigningKeyId === agent.certificate.signingKeyId,
      );
      return {
        agent_certificate: agentCertificateToDto(agent.certificate),
        agent_key_revocations: vault.keys
          .listAgentKeyRevocations(agent.certificate.agentId)
          .map(agentKeyRevocationToDto),
        prekeys: prekeys.map(
          (prekey: StoredPrekey): PrekeyCertificateDto =>
            prekeyCertificateToDto(prekey.certificate),
        ),
      };
    });
  return {
    agents,
    protocol: "murmur-e2ee-v1",
    root_key_id: root.rootKeyId,
    root_public_key: Buffer.from(root.publicKey).toString("base64url"),
  };
}

export async function rotateLocalAgentKey(
  vault: LocalE2eeVault,
  agentId: string,
  now: Instant,
): Promise<AgentKeyCertificateDto> {
  if (vault.keys.getAgent(agentId) === null) {
    throw new Error("The local E2E agent key is not initialized; use an encrypted tool first");
  }
  const rotated: StoredAgentKey = await vault.keys.getOrCreateAgent(
    agentId,
    now.toISOString(),
    now.addDays(90).toISOString(),
    now.toISOString(),
    true,
  );
  return agentCertificateToDto(rotated.certificate);
}

export async function revokeLocalAgentKey(
  vault: LocalE2eeVault,
  agentId: string,
  reason: string,
  now: Instant,
): Promise<LocalAgentKeyRevocation> {
  const revocation: AgentKeyRevocation = await vault.keys.revokeCurrentAgentKey(
    agentId,
    reason,
    now.toISOString(),
  );
  const replacement: StoredAgentKey = await vault.keys.getOrCreateAgent(
    agentId,
    now.toISOString(),
    now.addDays(90).toISOString(),
    now.toISOString(),
  );
  if (replacement.certificate.signingKeyId === revocation.revokedSigningKeyId) {
    throw new Error("Revoked E2E agent key remained active");
  }
  return {
    replacement_agent_certificate: agentCertificateToDto(replacement.certificate),
    revocation: agentKeyRevocationToDto(revocation),
  };
}

function availableCurrentPrekeys(
  vault: LocalE2eeVault,
  agent: StoredAgentKey,
  prekeyClass: "fallback" | "one_time",
  now: Instant,
): readonly StoredPrekey[] {
  const nowMillis: number = now.toEpochMilliseconds();
  return vault.keys
    .listPrekeys(agent.certificate.agentId, prekeyClass)
    .filter(
      (prekey: StoredPrekey): boolean =>
        prekey.privateKey !== null &&
        prekey.consumedAt === null &&
        prekey.certificate.agentSigningKeyId === agent.certificate.signingKeyId &&
        Date.parse(prekey.certificate.expiresAt) > nowMillis,
    );
}

export async function replenishLocalPrekeys(
  vault: LocalE2eeVault,
  agentId: string,
  now: Instant,
): Promise<LocalPrekeyReplenishment> {
  vault.purgeExpired(now.toISOString());
  const agent: StoredAgentKey = await vault.keys.getOrCreateAgent(
    agentId,
    now.toISOString(),
    now.addDays(90).toISOString(),
    now.addDays(30).toISOString(),
  );
  let fallback: readonly StoredPrekey[] = availableCurrentPrekeys(vault, agent, "fallback", now);
  if (fallback.length === 0) {
    await vault.keys.replenishPrekeys(
      agentId,
      "fallback",
      1,
      now.toISOString(),
      now.addDays(37).toISOString(),
    );
    fallback = availableCurrentPrekeys(vault, agent, "fallback", now);
  }
  let oneTime: readonly StoredPrekey[] = availableCurrentPrekeys(vault, agent, "one_time", now);
  if (oneTime.length < 20) {
    await vault.keys.replenishPrekeys(
      agentId,
      "one_time",
      20 - oneTime.length,
      now.toISOString(),
      now.addDays(37).toISOString(),
    );
    oneTime = availableCurrentPrekeys(vault, agent, "one_time", now);
  }
  return {
    agent_key_id: agent.certificate.signingKeyId,
    fallback_available: fallback.length,
    one_time_available: oneTime.length,
  };
}

export function trustPeerFingerprint(
  vault: LocalE2eeVault,
  input: TrustPeerFingerprintInput,
  now: Instant,
): LocalPeerTrustSummary {
  const expected: ExpectedPeerRoot = vault.keys.expectPeerRoot({
    agentId: input.agentId,
    rootKeyId: input.rootKeyId,
    tenantId: input.tenantId,
    verifiedAt: now.toISOString(),
  });
  return expectationSummary(expected);
}

export async function importOrganizationTrustFile(
  vault: LocalE2eeVault,
  serialized: string,
  expectedIssuerKeyId: string,
  now: Instant,
): Promise<StoredTrustPolicyState> {
  const policy: OrganizationTrustPolicy = parseSerializedTrustPolicy(serialized);
  return await vault.trust.applyPolicy(policy, expectedIssuerKeyId, new Date(now.toISOString()));
}
