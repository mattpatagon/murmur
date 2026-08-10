import type { Instant, JsonObject, TenantId } from "../domain/value-objects.js";
import type { PostgresTlsConfiguration } from "../postgres-tls.js";

export type TenantTokenRole = "agent" | "tenant_admin";
export type TenantStatus = "active" | "suspended";

export type TenantPrincipal = {
  readonly kind: "tenant";
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
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly name: string;
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
  readonly createdAt: Instant;
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly lastUsedAt: Instant | null;
  readonly name: string;
  readonly revokedAt: Instant | null;
  readonly role: TenantTokenRole;
  readonly tokenId: string;
};

export type OperatorTokenSummary = Omit<TokenSummary, "role">;

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
  createToken(
    tenantId: TenantId,
    role: TenantTokenRole,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken>;
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
  listTokens(tenantId: TenantId, cursor: string | null, limit: number): Promise<Page<TokenSummary>>;
  mintTenantAdminToken(
    principal: OperatorPrincipal,
    tenantId: TenantId,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken>;
  restoreTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean>;
  revokeOperatorToken(principal: OperatorPrincipal, keyId: string): Promise<string | null>;
  revokeToken(tenantId: TenantId, keyId: string): Promise<string | null>;
  suspendTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean>;
  tenantOnboardingEnabled(): Promise<boolean>;
}
