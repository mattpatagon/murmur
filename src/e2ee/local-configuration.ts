import type { Clock, Instant } from "../domain/value-objects.js";
import {
  exportLocalPublicIdentity,
  importOrganizationTrustFile,
  type LocalAgentKeyRevocation,
  type LocalPeerTrustSummary,
  type LocalPrekeyReplenishment,
  type LocalPublicAgentIdentity,
  type LocalPublicIdentityExport,
  listLocalPeerTrust,
  localE2eeFingerprint,
  localE2eeStatus,
  revokeLocalAgentKey,
  rotateLocalAgentKey,
  trustPeerFingerprint,
} from "./local-commands.js";
import type {
  LocalAgentInput,
  LocalExportInput,
  LocalKeyChangeInput,
  LocalPageInput,
  LocalPeersOutput,
  LocalPublicExportOutput,
  LocalRevokeInput,
  LocalStatusOutput,
  LocalTrustInput,
  LocalTrustPolicyInput,
  LocalTrustPolicyOutput,
} from "./local-configuration-contracts.js";
import {
  type CreateLocalTrustPolicyInput,
  type CreateLocalTrustPolicyOutput,
  createLocalTrustPolicy,
} from "./local-trust-authoring.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { StoredAgentKey } from "./local-vault-rows.js";
import type { ActiveTenantBinding } from "./local-vault-settings.js";
import type { StoredTrustPolicyState } from "./local-vault-trust.js";
import { type LocalPublishedIdentity, publishLocalIdentity } from "./proxy-identity.js";
import type { E2eeRemoteClient } from "./remote-client.js";
import { type OrganizationTrustPolicy, parseSerializedTrustPolicy } from "./trust-policy.js";
import type { AgentKeyCertificateDto } from "./wire-contracts.js";

export type LocalEncryptionDependencies = {
  readonly clock: Clock;
  readonly ensureOpen: () => void;
  readonly remote: E2eeRemoteClient;
  readonly vault: LocalE2eeVault;
};

export class LocalEncryptionConfiguration {
  readonly #dependencies: LocalEncryptionDependencies;

  public constructor(dependencies: LocalEncryptionDependencies) {
    this.#dependencies = dependencies;
  }

  #vault(): LocalE2eeVault {
    this.#dependencies.ensureOpen();
    return this.#dependencies.vault;
  }

  #activeTenant(): ActiveTenantBinding {
    const active: ActiveTenantBinding | null = this.#vault().settings.getActiveTenant();
    if (active === null)
      throw new Error(
        "Start the encrypted Murmur proxy with the intended credential to bind the local tenant first",
      );
    return active;
  }

  #agent(agentId: string): StoredAgentKey {
    const agent: StoredAgentKey | null = this.#vault().keys.getAgent(agentId);
    if (agent === null)
      throw new Error(
        "Register this agent through the encrypted proxy before configuring its local keys",
      );
    return agent;
  }

  #requireCurrentKey(input: LocalKeyChangeInput): void {
    if (this.#agent(input.agent_id).certificate.signingKeyId !== input.expected_agent_key_id) {
      throw new Error("The local agent key changed; export its public identity before retrying");
    }
  }

  async #publish(agentId: string, now: Instant): Promise<LocalPublishedIdentity> {
    try {
      return await publishLocalIdentity(this.#vault(), this.#dependencies.remote, agentId, now);
    } catch (_error: unknown) {
      throw new Error(
        "Local key changes were saved, but public bundle publication failed. Call e2ee_local_replenish_prekeys to retry publication",
      );
    }
  }

  public status(): LocalStatusOutput {
    const active: ActiveTenantBinding | null = this.#vault().settings.getActiveTenant();
    return {
      ...localE2eeStatus(this.#vault()),
      active_tenant_bound_at: active === null ? null : active.boundAt,
      active_tenant_id: active === null ? null : active.tenantId,
    };
  }

  public fingerprint(): { readonly root_key_id: string } {
    return { root_key_id: localE2eeFingerprint(this.#vault()) };
  }

  public peers(input: LocalPageInput): LocalPeersOutput {
    const peers: readonly LocalPeerTrustSummary[] = listLocalPeerTrust(this.#vault());
    const offset: number = input.offset === undefined ? 0 : input.offset;
    const limit: number = input.limit === undefined ? 100 : input.limit;
    return {
      next_offset: offset + limit < peers.length ? offset + limit : null,
      peers: peers.slice(offset, offset + limit),
    };
  }

  public trustPeer(input: LocalTrustInput): LocalPeerTrustSummary {
    return trustPeerFingerprint(
      this.#vault(),
      {
        agentId: input.agent_id,
        rootKeyId: input.root_key_id,
        tenantId: this.#activeTenant().tenantId,
      },
      this.#dependencies.clock.now(),
    );
  }

  public async importTrustPolicy(input: LocalTrustPolicyInput): Promise<LocalTrustPolicyOutput> {
    const active: ActiveTenantBinding = this.#activeTenant();
    const policy: OrganizationTrustPolicy = parseSerializedTrustPolicy(input.policy_json);
    if (policy.tenantId !== active.tenantId)
      throw new Error("The organization trust policy does not match the active tenant");
    const current: StoredTrustPolicyState | null = this.#vault().trust.getPolicyState(
      active.tenantId,
    );
    const issuer: string | null =
      input.issuer_key_id === undefined
        ? current === null
          ? null
          : current.issuerKeyId
        : input.issuer_key_id;
    if (issuer === null)
      throw new Error(
        "An independently verified issuer_key_id is required for the first organization trust import",
      );
    const stored: StoredTrustPolicyState = await importOrganizationTrustFile(
      this.#vault(),
      input.policy_json,
      issuer,
      this.#dependencies.clock.now(),
    );
    return {
      expires_at: stored.expiresAt,
      imported_at: stored.importedAt,
      issuer_key_id: stored.issuerKeyId,
      tenant_id: stored.tenantId,
      version: stored.version,
    };
  }

  public async createTrustPolicy(
    input: CreateLocalTrustPolicyInput,
  ): Promise<CreateLocalTrustPolicyOutput> {
    return await createLocalTrustPolicy(this.#vault(), input, this.#dependencies.clock.now());
  }

  public async rotateAgentKey(input: LocalKeyChangeInput): Promise<AgentKeyCertificateDto> {
    this.#requireCurrentKey(input);
    const now: Instant = this.#dependencies.clock.now();
    const output: AgentKeyCertificateDto = await rotateLocalAgentKey(
      this.#vault(),
      input.agent_id,
      now,
    );
    await this.#publish(input.agent_id, now);
    return output;
  }

  public async revokeAgentKey(input: LocalRevokeInput): Promise<LocalAgentKeyRevocation> {
    this.#requireCurrentKey(input);
    const now: Instant = this.#dependencies.clock.now();
    const output: LocalAgentKeyRevocation = await revokeLocalAgentKey(
      this.#vault(),
      input.agent_id,
      input.reason,
      now,
    );
    await this.#publish(input.agent_id, now);
    return output;
  }

  public async replenishPrekeys(input: LocalAgentInput): Promise<LocalPrekeyReplenishment> {
    this.#agent(input.agent_id);
    const now: Instant = this.#dependencies.clock.now();
    const published: LocalPublishedIdentity = await this.#publish(input.agent_id, now);
    return {
      agent_key_id: published.agent.certificate.signingKeyId,
      fallback_available: 1,
      one_time_available: published.oneTimePrekeys.length,
    };
  }

  public exportPublic(input: LocalExportInput): LocalPublicExportOutput {
    this.#agent(input.agent_id);
    const exported: LocalPublicIdentityExport = exportLocalPublicIdentity(
      this.#vault(),
      input.agent_id,
    );
    const agent: LocalPublicAgentIdentity | undefined = exported.agents[0];
    if (agent === undefined) throw new Error("The local public agent identity is unavailable");
    const offset: number = input.prekey_offset === undefined ? 0 : input.prekey_offset;
    return {
      ...exported,
      agents: [{ ...agent, prekeys: agent.prekeys.slice(offset, offset + 100) }],
      next_prekey_offset: offset + 100 < agent.prekeys.length ? offset + 100 : null,
    };
  }
}
