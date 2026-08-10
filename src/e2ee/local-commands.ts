import type { Instant } from "../domain/value-objects.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { ExpectedPeerRoot, PeerPin, StoredRootKey } from "./local-vault-rows.js";
import type { StoredAgentKey, StoredPrekey } from "./local-vault-rows.js";
import type { StoredTrustPolicyState } from "./local-vault-trust.js";
import { type OrganizationTrustPolicy, parseSerializedTrustPolicy } from "./trust-policy.js";
import {
  type AgentKeyCertificateDto,
  agentCertificateToDto,
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
  readonly prekeys: readonly PrekeyCertificateDto[];
};

export type LocalPublicIdentityExport = {
  readonly agents: readonly LocalPublicAgentIdentity[];
  readonly protocol: "murmur-e2ee-v1";
  readonly root_key_id: string;
  readonly root_public_key: string;
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

export function exportLocalPublicIdentity(vault: LocalE2eeVault): LocalPublicIdentityExport {
  const root: StoredRootKey | null = vault.keys.getRoot();
  if (root === null) {
    throw new Error("The local E2E identity is not initialized; there is no public key to export");
  }
  const agents: readonly LocalPublicAgentIdentity[] = vault.keys
    .listAgents()
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
