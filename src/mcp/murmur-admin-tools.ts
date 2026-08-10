import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { Instant, TenantId } from "../domain/value-objects.js";
import {
  type BootstrapOperatorInput,
  BootstrapOperatorInputSchema,
  type CreateOperatorTokenInput,
  CreateOperatorTokenInputSchema,
  type CreateTenantInput,
  CreateTenantInputSchema,
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type CreateTokenInput,
  CreateTokenInputSchema,
  type IssuedOperatorTokenOutput,
  IssuedOperatorTokenOutputSchema,
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListAdminAuditInput,
  ListAdminAuditInputSchema,
  type ListAdminAuditOutput,
  ListAdminAuditOutputSchema,
  type ListOperatorTokensInput,
  ListOperatorTokensInputSchema,
  type ListOperatorTokensOutput,
  ListOperatorTokensOutputSchema,
  type ListTenantsInput,
  ListTenantsInputSchema,
  type ListTenantsOutput,
  ListTenantsOutputSchema,
  type ListTokensInput,
  ListTokensInputSchema,
  type ListTokensOutput,
  ListTokensOutputSchema,
  type MintTenantAdminTokenInput,
  MintTenantAdminTokenInputSchema,
  type RevokeTokenInput,
  RevokeTokenInputSchema,
  type RevokeTokenOutput,
  RevokeTokenOutputSchema,
  type TenantIdInput,
  TenantIdInputSchema,
  type TenantStatusOutput,
  TenantStatusOutputSchema,
  toAdminAuditEventDto,
  toIssuedOperatorTokenDto,
  toIssuedTokenDto,
  toOperatorTokenSummaryDto,
  toTenantSummaryDto,
  toTokenSummaryDto,
} from "../hosted/contracts.js";
import type {
  AdminAuditEvent,
  HostedControlPlane,
  IssuedOperatorToken,
  IssuedToken,
  OperatorPrincipal,
  OperatorTokenSummary,
  Page,
  TenantPrincipal,
  TenantSummary,
  TokenSummary,
} from "../hosted/control-plane.js";
import { toolResult } from "./murmur-tool-results.js";

export type AdminToolContext = {
  readonly controlPlane: HostedControlPlane;
  readonly legacyCredentialHash: Buffer | null;
  readonly onTenantSuspended: ((tenantId: TenantId) => Promise<void>) | null;
  readonly onTokenRevoked: ((tokenId: string) => Promise<void>) | null;
  readonly tenantOnboardingEnabled: boolean;
};

function expiration(value: string | undefined): Instant | null {
  return value === undefined ? null : Instant.parse(value);
}

export async function callTenantAdminTool(
  name: string,
  argumentsValue: unknown,
  principal: TenantPrincipal,
  context: AdminToolContext,
): Promise<CallToolResult | null> {
  const controlPlane: HostedControlPlane = context.controlPlane;
  switch (name) {
    case "create_access_token": {
      const input: CreateTokenInput = CreateTokenInputSchema.parse(argumentsValue);
      const token: IssuedToken = await controlPlane.createToken(
        principal.tenantId,
        input.role,
        input.name,
        expiration(input.expires_at),
      );
      const output: IssuedTokenOutput = IssuedTokenOutputSchema.parse({
        token: toIssuedTokenDto(token),
      });
      return toolResult(output);
    }
    case "list_access_tokens": {
      const input: ListTokensInput = ListTokensInputSchema.parse(argumentsValue);
      const tokenPage: Page<TokenSummary> = await controlPlane.listTokens(
        principal.tenantId,
        input.cursor ?? null,
        input.limit ?? 100,
      );
      const output: ListTokensOutput = ListTokensOutputSchema.parse({
        next_cursor: tokenPage.nextCursor,
        tokens: tokenPage.items.map(toTokenSummaryDto),
      });
      return toolResult(output);
    }
    case "revoke_access_token": {
      const input: RevokeTokenInput = RevokeTokenInputSchema.parse(argumentsValue);
      const tokenId: string | null = await controlPlane.revokeToken(
        principal.tenantId,
        input.key_id,
      );
      if (tokenId !== null && context.onTokenRevoked !== null) {
        await context.onTokenRevoked(tokenId);
      }
      const output: RevokeTokenOutput = RevokeTokenOutputSchema.parse({
        revoked: tokenId !== null,
      });
      return toolResult(output);
    }
    default:
      return null;
  }
}

export async function callBootstrapTool(
  name: string,
  argumentsValue: unknown,
  bootstrapCredentialHash: Buffer,
  context: AdminToolContext,
): Promise<CallToolResult | null> {
  if (name !== "bootstrap_operator") return null;
  const input: BootstrapOperatorInput = BootstrapOperatorInputSchema.parse(argumentsValue);
  const token: IssuedOperatorToken = await context.controlPlane.bootstrapOperatorToken(
    bootstrapCredentialHash,
    input.name,
    input.secret,
  );
  const output: IssuedOperatorTokenOutput = IssuedOperatorTokenOutputSchema.parse({
    token: toIssuedOperatorTokenDto(token),
  });
  return toolResult(output);
}

export async function callOperatorTool(
  name: string,
  argumentsValue: unknown,
  principal: OperatorPrincipal,
  context: AdminToolContext,
): Promise<CallToolResult | null> {
  const controlPlane: HostedControlPlane = context.controlPlane;
  switch (name) {
    case "adopt_legacy_founding_token": {
      if (context.legacyCredentialHash === null) return null;
      z.strictObject({}).parse(argumentsValue);
      const changed: boolean = await controlPlane.adoptLegacyFoundingToken(
        principal,
        context.legacyCredentialHash,
      );
      const output: TenantStatusOutput = TenantStatusOutputSchema.parse({ changed });
      return toolResult(output);
    }
    case "create_operator_token": {
      const input: CreateOperatorTokenInput = CreateOperatorTokenInputSchema.parse(argumentsValue);
      const token: IssuedOperatorToken = await controlPlane.createOperatorToken(
        principal,
        input.name,
        expiration(input.expires_at),
      );
      const output: IssuedOperatorTokenOutput = IssuedOperatorTokenOutputSchema.parse({
        token: toIssuedOperatorTokenDto(token),
      });
      return toolResult(output);
    }
    case "list_operator_tokens": {
      const input: ListOperatorTokensInput = ListOperatorTokensInputSchema.parse(argumentsValue);
      const tokenPage: Page<OperatorTokenSummary> = await controlPlane.listOperatorTokens(
        principal,
        input.cursor ?? null,
        input.limit ?? 100,
      );
      const output: ListOperatorTokensOutput = ListOperatorTokensOutputSchema.parse({
        next_cursor: tokenPage.nextCursor,
        tokens: tokenPage.items.map(toOperatorTokenSummaryDto),
      });
      return toolResult(output);
    }
    case "revoke_operator_token": {
      const input: RevokeTokenInput = RevokeTokenInputSchema.parse(argumentsValue);
      const tokenId: string | null = await controlPlane.revokeOperatorToken(
        principal,
        input.key_id,
      );
      if (tokenId !== null && context.onTokenRevoked !== null) {
        await context.onTokenRevoked(tokenId);
      }
      const output: RevokeTokenOutput = RevokeTokenOutputSchema.parse({
        revoked: tokenId !== null,
      });
      return toolResult(output);
    }
    case "list_admin_audit": {
      const input: ListAdminAuditInput = ListAdminAuditInputSchema.parse(argumentsValue);
      const events: readonly AdminAuditEvent[] = await controlPlane.listAdminAudit(
        principal,
        input.limit,
      );
      const output: ListAdminAuditOutput = ListAdminAuditOutputSchema.parse({
        events: events.map(toAdminAuditEventDto),
      });
      return toolResult(output);
    }
    case "create_tenant": {
      if (!context.tenantOnboardingEnabled) return null;
      const input: CreateTenantInput = CreateTenantInputSchema.parse(argumentsValue);
      const created: { readonly tenant: TenantSummary; readonly token: IssuedToken } =
        await controlPlane.createTenant(principal, input.slug, input.display_name);
      const output: CreateTenantOutput = CreateTenantOutputSchema.parse({
        tenant: toTenantSummaryDto(created.tenant),
        token: toIssuedTokenDto(created.token),
      });
      return toolResult(output);
    }
    case "list_tenants": {
      const input: ListTenantsInput = ListTenantsInputSchema.parse(argumentsValue);
      const tenantPage: Page<TenantSummary> = await controlPlane.listTenants(
        principal,
        input.cursor ?? null,
        input.limit ?? 100,
      );
      const output: ListTenantsOutput = ListTenantsOutputSchema.parse({
        next_cursor: tenantPage.nextCursor,
        tenants: tenantPage.items.map(toTenantSummaryDto),
      });
      return toolResult(output);
    }
    case "mint_tenant_admin_token": {
      const input: MintTenantAdminTokenInput =
        MintTenantAdminTokenInputSchema.parse(argumentsValue);
      const token: IssuedToken = await controlPlane.mintTenantAdminToken(
        principal,
        TenantId.parse(input.tenant_id),
        input.name,
        expiration(input.expires_at),
      );
      const output: IssuedTokenOutput = IssuedTokenOutputSchema.parse({
        token: toIssuedTokenDto(token),
      });
      return toolResult(output);
    }
    case "suspend_tenant": {
      const input: TenantIdInput = TenantIdInputSchema.parse(argumentsValue);
      const tenantId: TenantId = TenantId.parse(input.tenant_id);
      const changed: boolean = await controlPlane.suspendTenant(principal, tenantId);
      if (changed && context.onTenantSuspended !== null) {
        await context.onTenantSuspended(tenantId);
      }
      const output: TenantStatusOutput = TenantStatusOutputSchema.parse({ changed });
      return toolResult(output);
    }
    case "restore_tenant": {
      const input: TenantIdInput = TenantIdInputSchema.parse(argumentsValue);
      const output: TenantStatusOutput = TenantStatusOutputSchema.parse({
        changed: await controlPlane.restoreTenant(principal, TenantId.parse(input.tenant_id)),
      });
      return toolResult(output);
    }
    default:
      return null;
  }
}
