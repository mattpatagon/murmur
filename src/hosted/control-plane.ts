import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { z } from "zod";

import type { OrchestratorPolicyId, PersonalId } from "../domain/orchestration.js";
import type { AgentId, Instant, RepositoryName, TenantId } from "../domain/value-objects.js";
import { POSTGRES_RUNTIME_POOL } from "../postgres-runtime.js";
import { verifyPostgresStorageBudgetSchema } from "../storage/postgres-storage-budget-schema.js";
import { type PostgresSslOptions, postgresSslOptions } from "../postgres-tls.js";
import { logSafeError } from "../safe-errors.js";
import type {
  AdminAuditEvent,
  AskOrchestratorCommand,
  CredentialAdmission,
  EffectiveOrchestrator,
  HostedControlPlane,
  HostedPrincipal,
  HostedTlsConfiguration,
  IssuedOperatorToken,
  IssuedToken,
  OperatorPrincipal,
  OperatorTokenSummary,
  OrchestrationRequestResult,
  OrchestratorPolicy,
  OrchestratorScope,
  Page,
  TenantPrincipal,
  TenantSummary,
  TenantTokenRole,
  TokenSummary,
} from "./control-plane-contracts.js";
import {
  hostedHasActiveOperator,
  hostedTenantOnboardingEnabled,
  listHostedAdminAudit,
  verifyHostedControlPlaneSchema,
} from "./control-plane-queries.js";
import {
  BooleanRowSchema,
  mapOperatorToken,
  NullableTokenIdRowSchema,
  OperatorTokenRowSchema,
  onlyRow,
  page,
} from "./control-plane-rows.js";
import {
  getPostgresE2eeEntitlement,
  resetPostgresE2eeIdentity,
  transitionPostgresE2ee,
} from "./e2ee-control-plane.js";
import type {
  E2eeEntitlementRecord,
  E2eeTransitionAction,
  E2eeTransitionResult,
} from "./e2ee-entitlement.js";
import { HostedAuthenticator } from "./hosted-authenticator.js";
import {
  changePostgresTenantStatus,
  createPostgresTenant,
  listPostgresTenants,
  mintPostgresTenantAdminToken,
} from "./operator-tenant-control-plane.js";
import {
  askPostgresOrchestrator,
  clearPostgresOrchestratorPolicy,
  getPostgresDelegation,
  resolvePostgresOrchestrator,
  setPostgresOrchestratorPolicy,
} from "./orchestration-control-plane.js";
import { listPostgresOrchestratorPolicies } from "./orchestration-policy-list.js";
import { createSelfServicePostgresTenant } from "./self-service-tenant-control-plane.js";
import {
  createPostgresOrchestratorToken,
  createPostgresTenantToken,
  listPostgresTenantTokens,
  revokePostgresTenantToken,
} from "./tenant-token-control-plane.js";
import { issueOperatorToken, providedOperatorToken } from "./token-issuance.js";

export type * from "./control-plane-contracts.js";

export class PostgresHostedControlPlane implements HostedControlPlane {
  private readonly authenticator: HostedAuthenticator;
  private readonly database: Sql;
  private closed: boolean;

  private constructor(database: Sql) {
    this.authenticator = new HostedAuthenticator(database);
    this.closed = false;
    this.database = database;
  }

  public static async connect(
    databaseUrl: string,
    tlsConfiguration: HostedTlsConfiguration,
  ): Promise<PostgresHostedControlPlane> {
    const ssl: PostgresSslOptions = postgresSslOptions(databaseUrl, tlsConfiguration);
    const database: Sql = postgres(databaseUrl, { ...POSTGRES_RUNTIME_POOL, ssl });
    const controlPlane: PostgresHostedControlPlane = new PostgresHostedControlPlane(database);
    try {
      await controlPlane.ensureSchema();
      await controlPlane.authenticator.start();
      return controlPlane;
    } catch (error: unknown) {
      await database.end({ timeout: 1 });
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The hosted control plane is closed");
  }

  private async refreshCredentialAdmissions(): Promise<void> {
    await this.authenticator.refresh();
  }

  public credentialAdmission(token: string): CredentialAdmission | null {
    return this.authenticator.credentialAdmission(token);
  }

  private async ensureSchema(): Promise<void> {
    await verifyHostedControlPlaneSchema(this.database);
    await verifyPostgresStorageBudgetSchema(this.database);
  }

  public async authenticate(token: string): Promise<HostedPrincipal | null> {
    this.ensureOpen();
    return await this.authenticator.authenticate(token);
  }

  public async getE2eeEntitlement(principal: TenantPrincipal): Promise<E2eeEntitlementRecord> {
    this.ensureOpen();
    return await getPostgresE2eeEntitlement(this.database, principal);
  }

  public async resetE2eeIdentity(
    principal: TenantPrincipal,
    agentId: AgentId,
    expectedRootKeyId: string,
    reason: string,
  ): Promise<boolean> {
    this.ensureOpen();
    return await resetPostgresE2eeIdentity(
      this.database,
      principal,
      agentId,
      expectedRootKeyId,
      reason,
    );
  }

  public async transitionE2ee(
    principal: TenantPrincipal,
    action: E2eeTransitionAction,
    expectedState: E2eeEntitlementRecord["state"],
    trustPolicyVersion: number | null,
  ): Promise<E2eeTransitionResult> {
    this.ensureOpen();
    return await transitionPostgresE2ee(
      this.database,
      principal,
      action,
      expectedState,
      trustPolicyVersion,
    );
  }

  public async hasActiveOperator(): Promise<boolean> {
    this.ensureOpen();
    return await hostedHasActiveOperator(this.database);
  }

  public async tenantOnboardingEnabled(): Promise<boolean> {
    this.ensureOpen();
    return await hostedTenantOnboardingEnabled(this.database);
  }

  public async bootstrapOperatorToken(
    bootstrapCredentialHash: Buffer,
    name: string,
    secret: string,
  ): Promise<IssuedOperatorToken> {
    this.ensureOpen();
    const issued: ReturnType<typeof providedOperatorToken> = providedOperatorToken(name, secret);
    await this.database`
      SELECT murmur.operator_bootstrap(
        ${bootstrapCredentialHash},
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${name}
      )
    `;
    await this.refreshCredentialAdmissions();
    return issued.token;
  }

  public async adoptLegacyFoundingToken(
    principal: OperatorPrincipal,
    legacyCredentialHash: Buffer,
  ): Promise<boolean> {
    this.ensureOpen();
    const keyId: string = `legacy_${legacyCredentialHash.toString("base64url").slice(0, 12)}`;
    const rawRows: unknown = await this.database`
      SELECT murmur.operator_adopt_legacy_founding_token(
        ${principal.credentialHash},
        ${randomUUID()}::uuid,
        ${keyId},
        ${legacyCredentialHash}
      ) AS changed
    `;
    const changed: boolean = onlyRow(
      z.array(BooleanRowSchema).parse(rawRows),
      "adopt legacy founding token",
    ).changed;
    await this.refreshCredentialAdmissions();
    return changed;
  }

  public async createOperatorToken(
    principal: OperatorPrincipal,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedOperatorToken> {
    this.ensureOpen();
    const issued: ReturnType<typeof issueOperatorToken> = issueOperatorToken(name, expiresAt);
    await this.database`
      SELECT murmur.operator_create_operator_token(
        ${principal.credentialHash},
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${name},
        ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz
      )
    `;
    await this.refreshCredentialAdmissions();
    return issued.token;
  }

  public async listOperatorTokens(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<OperatorTokenSummary>> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT
        token_id::text AS token_id,
        key_id,
        name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        CASE WHEN expires_at IS NULL THEN NULL ELSE
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        CASE WHEN revoked_at IS NULL THEN NULL ELSE
          to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS revoked_at,
        CASE WHEN last_used_at IS NULL THEN NULL ELSE
          to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS last_used_at
      FROM murmur.operator_list_operator_tokens(
        ${principal.credentialHash},
        ${cursor}::uuid,
        ${limit + 1}
      )
    `;
    const items: readonly OperatorTokenSummary[] = z
      .array(OperatorTokenRowSchema)
      .parse(rawRows)
      .map(mapOperatorToken);
    return page(items, limit, (item: OperatorTokenSummary): string => item.tokenId);
  }

  public async revokeOperatorToken(
    principal: OperatorPrincipal,
    keyId: string,
  ): Promise<string | null> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT murmur.operator_revoke_operator_token(
        ${principal.credentialHash}, ${keyId}
      )::text AS token_id
    `;
    const tokenId: string | null = onlyRow(
      z.array(NullableTokenIdRowSchema).parse(rawRows),
      "revoke operator token",
    ).token_id;
    await this.refreshCredentialAdmissions();
    return tokenId;
  }

  public async createToken(
    principal: TenantPrincipal,
    role: TenantTokenRole,
    name: string,
    expiresAt: Instant | null,
    personalId: PersonalId | null,
    repositoryName: RepositoryName | null,
  ): Promise<IssuedToken> {
    this.ensureOpen();
    const token: IssuedToken = await createPostgresTenantToken(
      this.database,
      principal,
      role,
      name,
      expiresAt,
      personalId,
      repositoryName,
    );
    await this.refreshCredentialAdmissions();
    return token;
  }

  public async listTokens(
    principal: TenantPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TokenSummary>> {
    this.ensureOpen();
    return await listPostgresTenantTokens(this.database, principal, cursor, limit);
  }

  public async revokeToken(principal: TenantPrincipal, keyId: string): Promise<string | null> {
    this.ensureOpen();
    const tokenId: string | null = await revokePostgresTenantToken(this.database, principal, keyId);
    await this.refreshCredentialAdmissions();
    return tokenId;
  }

  public async createOrchestratorToken(
    principal: TenantPrincipal,
    agentId: AgentId,
    name: string,
    expiresAt: Instant | null,
    personalId: PersonalId | null,
    repositoryName: RepositoryName | null,
  ): Promise<IssuedToken> {
    this.ensureOpen();
    const token: IssuedToken = await createPostgresOrchestratorToken(
      this.database,
      principal,
      agentId,
      name,
      expiresAt,
      personalId,
      repositoryName,
    );
    await this.refreshCredentialAdmissions();
    return token;
  }

  public async setOrchestratorPolicy(
    principal: TenantPrincipal,
    scope: OrchestratorScope,
    orchestratorKeyId: string,
    instructions: string,
  ): Promise<OrchestratorPolicy> {
    this.ensureOpen();
    return await setPostgresOrchestratorPolicy(
      this.database,
      principal,
      scope,
      orchestratorKeyId,
      instructions,
    );
  }

  public async clearOrchestratorPolicy(
    principal: TenantPrincipal,
    scope: OrchestratorScope,
  ): Promise<boolean> {
    this.ensureOpen();
    return await clearPostgresOrchestratorPolicy(this.database, principal, scope);
  }

  public async listOrchestratorPolicies(
    principal: TenantPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<OrchestratorPolicy>> {
    this.ensureOpen();
    return await listPostgresOrchestratorPolicies(this.database, principal, cursor, limit);
  }

  public async resolveOrchestrator(
    principal: TenantPrincipal,
  ): Promise<EffectiveOrchestrator | null> {
    this.ensureOpen();
    return await resolvePostgresOrchestrator(this.database, principal);
  }

  public async askOrchestrator(
    principal: TenantPrincipal,
    command: AskOrchestratorCommand,
  ): Promise<OrchestrationRequestResult> {
    this.ensureOpen();
    return await askPostgresOrchestrator(this.database, principal, command);
  }

  public async getDelegation(
    principal: TenantPrincipal,
    policyId: OrchestratorPolicyId,
  ): Promise<OrchestratorPolicy | null> {
    this.ensureOpen();
    return await getPostgresDelegation(this.database, principal, policyId);
  }

  public async createTenant(
    principal: OperatorPrincipal,
    slug: string,
    displayName: string,
  ): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }> {
    this.ensureOpen();
    const created: { readonly tenant: TenantSummary; readonly token: IssuedToken } =
      await createPostgresTenant(this.database, principal, slug, displayName);
    await this.refreshCredentialAdmissions();
    return created;
  }
  public async selfServiceRegisterTenant(
    slug: string,
    displayName: string,
    registrationSecret: string,
  ): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }> {
    this.ensureOpen();
    const created: { readonly tenant: TenantSummary; readonly token: IssuedToken } =
      await createSelfServicePostgresTenant(this.database, slug, displayName, registrationSecret);
    try {
      await this.refreshCredentialAdmissions();
    } catch (error: unknown) {
      logSafeError("Murmur self-service credential admission refresh failed", error);
    }
    return created;
  }
  public async listTenants(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TenantSummary>> {
    this.ensureOpen();
    return await listPostgresTenants(this.database, principal, cursor, limit);
  }
  public async mintTenantAdminToken(
    principal: OperatorPrincipal,
    tenantId: TenantId,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken> {
    this.ensureOpen();
    const token: IssuedToken = await mintPostgresTenantAdminToken(
      this.database,
      principal,
      tenantId,
      name,
      expiresAt,
    );
    await this.refreshCredentialAdmissions();
    return token;
  }
  private async changeTenantStatus(
    principal: OperatorPrincipal,
    functionName: "restore" | "suspend",
    tenantId: TenantId,
  ): Promise<boolean> {
    this.ensureOpen();
    const changed: boolean = await changePostgresTenantStatus(
      this.database,
      principal,
      functionName,
      tenantId,
    );
    await this.refreshCredentialAdmissions();
    return changed;
  }
  public async suspendTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean> {
    return await this.changeTenantStatus(principal, "suspend", tenantId);
  }
  public async restoreTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean> {
    return await this.changeTenantStatus(principal, "restore", tenantId);
  }
  public async listAdminAudit(
    principal: OperatorPrincipal,
    limit: number,
  ): Promise<readonly AdminAuditEvent[]> {
    this.ensureOpen();
    return await listHostedAdminAudit(this.database, principal, limit);
  }
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.authenticator.close();
    await this.database.end({ timeout: 5 });
  }
}
