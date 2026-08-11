import type { AgentClient, BranchName, RepositoryName, TenantId } from "../domain/value-objects.js";
import { E2EE_PROTOCOL } from "../e2ee/protocol.js";
import { MAX_E2EE_CIPHERTEXT_BYTES } from "../e2ee/wire-contracts.js";
import { E2EE_WIRE_VERSION, type E2eeCapabilityConfiguration } from "../e2ee/wire-tools.js";
import type { HostedAuthenticator } from "../hosted/authenticator.js";
import type {
  HostedControlPlane,
  HostedPrincipal,
  TenantPrincipal,
} from "../hosted/control-plane.js";
import {
  type E2eeEntitlementRecord,
  HOSTED_MAX_ONE_TIME_PREKEYS,
} from "../hosted/e2ee-entitlement.js";
import { MurmurApplication } from "../mcp/murmur-application.js";
import {
  type E2eeMessageStore,
  isE2eeMessageStoreProvider,
} from "../storage/e2ee-message-store.js";
import type { MessageStore } from "../storage/message-store.js";

export type HostedApplicationRequest = {
  readonly authenticator: HostedAuthenticator;
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly onRepositoryDivergence: () => void;
  readonly onTenantSuspended: (tenantId: TenantId) => Promise<void>;
  readonly onTokenRevoked: (tokenId: string) => Promise<void>;
  readonly principal: HostedPrincipal;
  readonly repositoryName: RepositoryName | null;
  readonly store: MessageStore;
  readonly token: string;
};

function canAccessTenantData(
  principal: HostedPrincipal,
  orchestrationEnabled: boolean,
): principal is TenantPrincipal {
  return principal.kind === "tenant" && (principal.role !== "orchestrator" || orchestrationEnabled);
}

function capability(
  principal: TenantPrincipal,
  entitlement: E2eeEntitlementRecord,
): E2eeCapabilityConfiguration {
  return {
    max_ciphertext_bytes: MAX_E2EE_CIPHERTEXT_BYTES,
    max_one_time_prekeys: HOSTED_MAX_ONE_TIME_PREKEYS,
    protocol: E2EE_PROTOCOL,
    state: entitlement.state,
    tenant_id: principal.tenantId.value,
    wire_version: E2EE_WIRE_VERSION,
  };
}

export async function createHostedMurmurApplication(
  request: HostedApplicationRequest,
): Promise<MurmurApplication> {
  const tenantPrincipal: TenantPrincipal | null = canAccessTenantData(
    request.principal,
    request.authenticator.orchestrationEnabled,
  )
    ? request.principal
    : null;
  const tenantStore: MessageStore | null =
    tenantPrincipal === null ? null : request.store.scope(tenantPrincipal.tenantId);
  let entitlement: E2eeEntitlementRecord | null = null;
  let encryptedStore: E2eeMessageStore | null = null;
  const controlPlane: HostedControlPlane | null = request.authenticator.controlPlane;
  if (tenantPrincipal !== null && controlPlane !== null) {
    entitlement = await controlPlane.getE2eeEntitlement(tenantPrincipal);
    if (!isE2eeMessageStoreProvider(request.store)) {
      throw new Error("Hosted encrypted storage is unavailable");
    }
    encryptedStore = request.store.scopeE2ee(tenantPrincipal.tenantId);
  }
  return new MurmurApplication({
    branchName: request.branchName,
    bootstrapCredentialHash: request.authenticator.bootstrapCredentialHash(
      request.principal,
      request.token,
    ),
    client: request.client,
    closeStoreOnClose: false,
    controlPlane: request.authenticator.controlPlane,
    e2eeCapability:
      tenantPrincipal === null || entitlement === null
        ? null
        : capability(tenantPrincipal, entitlement),
    e2eeEntitlement: entitlement,
    e2eeStore: encryptedStore,
    legacyCredentialHash: request.authenticator.legacyCredentialHash(request.principal),
    onE2eeStateChanged: request.onTenantSuspended,
    onRepositoryDivergence: request.onRepositoryDivergence,
    onTenantSuspended: request.onTenantSuspended,
    onTokenRevoked: request.onTokenRevoked,
    orchestrationEnabled: request.authenticator.orchestrationEnabled,
    principal: request.principal,
    repositoryName: request.repositoryName,
    store: tenantStore,
    tenantOnboardingEnabled: request.authenticator.tenantOnboardingEnabled,
  });
}
