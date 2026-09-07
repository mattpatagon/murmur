import type { Message } from "../domain/models.js";
import type {
  OrchestrationScopeKind,
  OrchestratorPolicyId,
  PersonalId,
} from "../domain/orchestration.js";
import type {
  AgentClient,
  AgentId,
  BranchName,
  IdempotencyKey,
  Instant,
  JsonObject,
  MachineName,
  MessageContent,
  RepositoryName,
  TenantId,
  ThreadId,
} from "../domain/value-objects.js";
import type { PostgresTlsConfiguration } from "../postgres-tls.js";
import type {
  E2eeEntitlementRecord,
  E2eeTransitionAction,
  E2eeTransitionResult,
} from "./e2ee-entitlement.js";

export type TenantTokenRole = "agent" | "orchestrator" | "tenant_admin";
export type TenantStatus = "active" | "suspended";

export type TenantPrincipal = {
  readonly agentId?: AgentId | null | undefined;
  readonly kind: "tenant";
  readonly machineName?: MachineName | null | undefined;
  readonly personalId?: PersonalId | null | undefined;
  readonly repositoryName?: RepositoryName | null | undefined;
  readonly role: TenantTokenRole;
  readonly tenantId: TenantId;
  readonly tokenId: string;
};

export type OperatorPrincipal = {
  readonly credentialHash: Buffer;
  readonly keyId: string;
  readonly kind: "operator";
  readonly tokenId: string;
};

export type BootstrapPrincipal = {
  readonly keyId: string;
  readonly kind: "bootstrap";
  readonly tokenId: string;
};

export type HostedPrincipal = BootstrapPrincipal | OperatorPrincipal | TenantPrincipal;
export type CredentialAdmission = { readonly key: string; readonly tenantKey: string | null };

export type IssuedToken = {
  readonly agentId: AgentId | null;
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly machineName: MachineName | null;
  readonly name: string;
  readonly personalId: PersonalId;
  readonly repositoryName: RepositoryName | null;
  readonly role: TenantTokenRole;
  readonly secret: string;
  readonly tenantId: TenantId;
  readonly tokenId: string;
};

export type IssuedOperatorToken = {
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly name: string;
  readonly secret: string;
  readonly tokenId: string;
};

export type TokenSummary = {
  readonly agentId: AgentId | null;
  readonly createdAt: Instant;
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly lastUsedAt: Instant | null;
  readonly name: string;
  readonly machineName: MachineName | null;
  readonly personalId: PersonalId;
  readonly repositoryName: RepositoryName | null;
  readonly revokedAt: Instant | null;
  readonly role: TenantTokenRole;
  readonly tokenId: string;
};

export type OperatorTokenSummary = {
  readonly createdAt: Instant;
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly lastUsedAt: Instant | null;
  readonly name: string;
  readonly revokedAt: Instant | null;
  readonly tokenId: string;
};

export type TenantSummary = {
  readonly createdAt: Instant;
  readonly displayName: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly suspendedAt: Instant | null;
  readonly tenantId: TenantId;
};

export type AdminAuditEvent = {
  readonly action: string;
  readonly actorKeyId: string;
  readonly actorTokenId: string;
  readonly auditId: number;
  readonly createdAt: Instant;
  readonly metadata: JsonObject;
  readonly targetId: string;
  readonly targetKind: string;
};

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };
export type HostedTlsConfiguration = PostgresTlsConfiguration;

export type OrchestratorScope = {
  readonly kind: OrchestrationScopeKind;
  readonly machineName: MachineName | null;
  readonly personalId: PersonalId | null;
  readonly repositoryName: RepositoryName | null;
};

export type OrchestratorPolicy = {
  readonly createdAt: Instant;
  readonly createdByTokenId: string;
  readonly enabled: boolean;
  readonly instructions: string;
  readonly orchestratorAgentId: AgentId;
  readonly orchestratorTokenId: string;
  readonly policyId: OrchestratorPolicyId;
  readonly scope: OrchestratorScope;
  readonly updatedAt: Instant;
  readonly updatedByTokenId: string;
};

export type EffectiveOrchestrator = Omit<
  OrchestratorPolicy,
  | "createdAt"
  | "createdByTokenId"
  | "enabled"
  | "instructions"
  | "orchestratorTokenId"
  | "updatedAt"
  | "updatedByTokenId"
>;

export type AskOrchestratorCommand = {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly content: MessageContent;
  readonly idempotencyKey: IdempotencyKey;
  readonly repositoryName: RepositoryName;
  readonly senderId: AgentId;
  readonly threadId: ThreadId | null;
};

export type OrchestrationRequestResult = {
  readonly duplicate: boolean;
  readonly message: Message;
  readonly policy: EffectiveOrchestrator;
};

export interface HostedControlPlane {
  authenticate(token: string): Promise<HostedPrincipal | null>;
  bootstrapOperatorToken(
    bootstrapCredentialHash: Buffer,
    name: string,
    secret: string,
  ): Promise<IssuedOperatorToken>;
  adoptLegacyFoundingToken(
    principal: OperatorPrincipal,
    legacyCredentialHash: Buffer,
  ): Promise<boolean>;
  close(): Promise<void>;
  credentialAdmission(token: string): CredentialAdmission | null;
  createOperatorToken(
    principal: OperatorPrincipal,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedOperatorToken>;
  createTenant(
    principal: OperatorPrincipal,
    slug: string,
    displayName: string,
  ): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }>;
  selfServiceRegisterTenant(
    slug: string,
    displayName: string,
    registrationSecret: string,
  ): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }>;
  createToken(
    principal: TenantPrincipal,
    role: TenantTokenRole,
    name: string,
    expiresAt: Instant | null,
    personalId: PersonalId | null,
    repositoryName: RepositoryName | null,
    machineName: MachineName | null,
  ): Promise<IssuedToken>;
  createOrchestratorToken(
    principal: TenantPrincipal,
    agentId: AgentId,
    name: string,
    expiresAt: Instant | null,
    personalId: PersonalId | null,
    repositoryName: RepositoryName | null,
    machineName: MachineName | null,
  ): Promise<IssuedToken>;
  setOrchestratorPolicy(
    principal: TenantPrincipal,
    scope: OrchestratorScope,
    orchestratorKeyId: string,
    instructions: string,
  ): Promise<OrchestratorPolicy>;
  clearOrchestratorPolicy(principal: TenantPrincipal, scope: OrchestratorScope): Promise<boolean>;
  listOrchestratorPolicies(
    principal: TenantPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<OrchestratorPolicy>>;
  resolveOrchestrator(principal: TenantPrincipal): Promise<EffectiveOrchestrator | null>;
  askOrchestrator(
    principal: TenantPrincipal,
    command: AskOrchestratorCommand,
  ): Promise<OrchestrationRequestResult>;
  getDelegation(
    principal: TenantPrincipal,
    policyId: OrchestratorPolicyId,
  ): Promise<OrchestratorPolicy | null>;
  getE2eeEntitlement(principal: TenantPrincipal): Promise<E2eeEntitlementRecord>;
  hasActiveOperator(): Promise<boolean>;
  listAdminAudit(principal: OperatorPrincipal, limit: number): Promise<readonly AdminAuditEvent[]>;
  listOperatorTokens(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<OperatorTokenSummary>>;
  listTenants(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TenantSummary>>;
  listTokens(
    principal: TenantPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TokenSummary>>;
  mintTenantAdminToken(
    principal: OperatorPrincipal,
    tenantId: TenantId,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken>;
  restoreTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean>;
  resetE2eeIdentity(
    principal: TenantPrincipal,
    agentId: AgentId,
    expectedRootKeyId: string,
    reason: string,
  ): Promise<boolean>;
  transitionE2ee(
    principal: TenantPrincipal,
    action: E2eeTransitionAction,
    expectedState: E2eeEntitlementRecord["state"],
    trustPolicyVersion: number | null,
  ): Promise<E2eeTransitionResult>;
  revokeOperatorToken(principal: OperatorPrincipal, keyId: string): Promise<string | null>;
  revokeToken(principal: TenantPrincipal, keyId: string): Promise<string | null>;
  suspendTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean>;
  tenantOnboardingEnabled(): Promise<boolean>;
}
