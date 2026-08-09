import { z } from "zod";

import { OperatorTokenSecretSchema, TenantTokenSecretSchema } from "./token-secret.js";

import type {
  AdminAuditEvent,
  IssuedToken,
  IssuedOperatorToken,
  OperatorTokenSummary,
  TenantStatus,
  TenantSummary,
  TenantTokenRole,
  TokenSummary,
} from "./control-plane.js";

const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const TenantIdSchema: z.ZodString = z.string().uuid();
const KeyIdSchema: z.ZodString = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/u);
const TokenNameSchema: z.ZodString = z.string().trim().min(1).max(200);
const TenantSlugSchema: z.ZodString = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u);
const TenantDisplayNameSchema: z.ZodString = z.string().trim().min(1).max(200);
const TokenRoleSchema: z.ZodEnum<{
  agent: "agent";
  tenant_admin: "tenant_admin";
}> = z.enum(["agent", "tenant_admin"]);
const TenantStatusSchema: z.ZodEnum<{
  active: "active";
  suspended: "suspended";
}> = z.enum(["active", "suspended"]);

export type CreateTokenInput = {
  readonly expires_at?: string | undefined;
  readonly name: string;
  readonly role: TenantTokenRole;
};

export type RevokeTokenInput = { readonly key_id: string };
export type ListPageInput = {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
};
export type ListTokensInput = ListPageInput;
export type BootstrapOperatorInput = {
  readonly name: string;
  readonly secret: string;
};
export type CreateOperatorTokenInput = {
  readonly expires_at?: string | undefined;
  readonly name: string;
};
export type ListOperatorTokensInput = ListPageInput;
export type ListAdminAuditInput = { readonly limit: number };

export type CreateTenantInput = {
  readonly display_name: string;
  readonly slug: string;
};

export type TenantIdInput = { readonly tenant_id: string };

export type MintTenantAdminTokenInput = TenantIdInput & {
  readonly expires_at?: string | undefined;
  readonly name: string;
};

export type ListTenantsInput = ListPageInput;

export type IssuedTokenDto = {
  readonly expires_at: string | null;
  readonly key_id: string;
  readonly name: string;
  readonly role: TenantTokenRole;
  readonly secret: string;
  readonly tenant_id: string;
  readonly token_id: string;
};

export type TokenSummaryDto = {
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly key_id: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly role: TenantTokenRole;
  readonly token_id: string;
};

export type IssuedOperatorTokenDto = {
  readonly expires_at: string | null;
  readonly key_id: string;
  readonly name: string;
  readonly secret: string;
  readonly token_id: string;
};

export type OperatorTokenSummaryDto = Omit<IssuedOperatorTokenDto, "secret"> & {
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
};

export type AdminAuditEventDto = {
  readonly action: string;
  readonly actor_key_id: string;
  readonly actor_token_id: string;
  readonly audit_id: number;
  readonly created_at: string;
  readonly metadata: Record<string, unknown>;
  readonly target_id: string;
  readonly target_kind: string;
};

export type TenantSummaryDto = {
  readonly created_at: string;
  readonly display_name: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly suspended_at: string | null;
  readonly tenant_id: string;
};

export type IssuedTokenOutput = Record<string, unknown> & {
  readonly token: IssuedTokenDto;
};

export type ListTokensOutput = Record<string, unknown> & {
  readonly next_cursor: string | null;
  readonly tokens: TokenSummaryDto[];
};

export type RevokeTokenOutput = Record<string, unknown> & {
  readonly revoked: boolean;
};
export type IssuedOperatorTokenOutput = Record<string, unknown> & {
  readonly token: IssuedOperatorTokenDto;
};
export type ListOperatorTokensOutput = Record<string, unknown> & {
  readonly next_cursor: string | null;
  readonly tokens: OperatorTokenSummaryDto[];
};
export type ListAdminAuditOutput = Record<string, unknown> & {
  readonly events: AdminAuditEventDto[];
};

export type CreateTenantOutput = Record<string, unknown> & {
  readonly tenant: TenantSummaryDto;
  readonly token: IssuedTokenDto;
};

export type ListTenantsOutput = Record<string, unknown> & {
  readonly next_cursor: string | null;
  readonly tenants: TenantSummaryDto[];
};

export type TenantStatusOutput = Record<string, unknown> & {
  readonly changed: boolean;
};

export const CreateTokenInputSchema: z.ZodType<CreateTokenInput> = z.strictObject({
  expires_at: InstantSchema.optional(),
  name: TokenNameSchema,
  role: TokenRoleSchema,
});

export const RevokeTokenInputSchema: z.ZodType<RevokeTokenInput> = z.strictObject({
  key_id: KeyIdSchema,
});

function listPageInputSchema(): z.ZodType<ListPageInput> {
  return z.strictObject({
    cursor: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  });
}

export const ListTokensInputSchema: z.ZodType<ListTokensInput> = listPageInputSchema();

export const BootstrapOperatorInputSchema: z.ZodType<BootstrapOperatorInput> = z.strictObject({
  name: TokenNameSchema,
  secret: OperatorTokenSecretSchema,
});

export const CreateOperatorTokenInputSchema: z.ZodType<CreateOperatorTokenInput> = z.strictObject({
  expires_at: InstantSchema.optional(),
  name: TokenNameSchema,
});

export const ListOperatorTokensInputSchema: z.ZodType<ListOperatorTokensInput> =
  listPageInputSchema();

export const ListAdminAuditInputSchema: z.ZodType<ListAdminAuditInput> = z.strictObject({
  limit: z.number().int().min(1).max(500).default(100),
});

export const CreateTenantInputSchema: z.ZodType<CreateTenantInput> = z.strictObject({
  display_name: TenantDisplayNameSchema,
  slug: TenantSlugSchema,
});

export const TenantIdInputSchema: z.ZodType<TenantIdInput> = z.strictObject({
  tenant_id: TenantIdSchema,
});

export const MintTenantAdminTokenInputSchema: z.ZodType<MintTenantAdminTokenInput> = z.strictObject(
  {
    expires_at: InstantSchema.optional(),
    name: TokenNameSchema,
    tenant_id: TenantIdSchema,
  },
);

export const ListTenantsInputSchema: z.ZodType<ListTenantsInput> = listPageInputSchema();

export const IssuedTokenDtoSchema: z.ZodType<IssuedTokenDto> = z.strictObject({
  expires_at: InstantSchema.nullable(),
  key_id: KeyIdSchema,
  name: TokenNameSchema,
  role: TokenRoleSchema,
  secret: TenantTokenSecretSchema,
  tenant_id: TenantIdSchema,
  token_id: z.string().uuid(),
});

export const TokenSummaryDtoSchema: z.ZodType<TokenSummaryDto> = z.strictObject({
  created_at: InstantSchema,
  expires_at: InstantSchema.nullable(),
  key_id: KeyIdSchema,
  last_used_at: InstantSchema.nullable(),
  name: TokenNameSchema,
  revoked_at: InstantSchema.nullable(),
  role: TokenRoleSchema,
  token_id: z.string().uuid(),
});

export const IssuedOperatorTokenDtoSchema: z.ZodType<IssuedOperatorTokenDto> = z.strictObject({
  expires_at: InstantSchema.nullable(),
  key_id: KeyIdSchema,
  name: TokenNameSchema,
  secret: OperatorTokenSecretSchema,
  token_id: z.string().uuid(),
});

export const OperatorTokenSummaryDtoSchema: z.ZodType<OperatorTokenSummaryDto> = z.strictObject({
  created_at: InstantSchema,
  expires_at: InstantSchema.nullable(),
  key_id: KeyIdSchema,
  last_used_at: InstantSchema.nullable(),
  name: TokenNameSchema,
  revoked_at: InstantSchema.nullable(),
  token_id: z.string().uuid(),
});

export const AdminAuditEventDtoSchema: z.ZodType<AdminAuditEventDto> = z.strictObject({
  action: z.string(),
  actor_key_id: KeyIdSchema,
  actor_token_id: z.string().uuid(),
  audit_id: z.number().int().positive(),
  created_at: InstantSchema,
  metadata: z.record(z.string(), z.unknown()),
  target_id: z.string(),
  target_kind: z.string(),
});

export const TenantSummaryDtoSchema: z.ZodType<TenantSummaryDto> = z.strictObject({
  created_at: InstantSchema,
  display_name: TenantDisplayNameSchema,
  slug: TenantSlugSchema,
  status: TenantStatusSchema,
  suspended_at: InstantSchema.nullable(),
  tenant_id: TenantIdSchema,
});

export const IssuedTokenOutputSchema: z.ZodType<IssuedTokenOutput> = z.strictObject({
  token: IssuedTokenDtoSchema,
});

export const ListTokensOutputSchema: z.ZodType<ListTokensOutput> = z.strictObject({
  next_cursor: z.string().uuid().nullable(),
  tokens: z.array(TokenSummaryDtoSchema),
});

export const RevokeTokenOutputSchema: z.ZodType<RevokeTokenOutput> = z.strictObject({
  revoked: z.boolean(),
});

export const IssuedOperatorTokenOutputSchema: z.ZodType<IssuedOperatorTokenOutput> = z.strictObject(
  {
    token: IssuedOperatorTokenDtoSchema,
  },
);

export const ListOperatorTokensOutputSchema: z.ZodType<ListOperatorTokensOutput> = z.strictObject({
  next_cursor: z.string().uuid().nullable(),
  tokens: z.array(OperatorTokenSummaryDtoSchema),
});

export const ListAdminAuditOutputSchema: z.ZodType<ListAdminAuditOutput> = z.strictObject({
  events: z.array(AdminAuditEventDtoSchema),
});

export const CreateTenantOutputSchema: z.ZodType<CreateTenantOutput> = z.strictObject({
  tenant: TenantSummaryDtoSchema,
  token: IssuedTokenDtoSchema,
});

export const ListTenantsOutputSchema: z.ZodType<ListTenantsOutput> = z.strictObject({
  next_cursor: z.string().uuid().nullable(),
  tenants: z.array(TenantSummaryDtoSchema),
});

export const TenantStatusOutputSchema: z.ZodType<TenantStatusOutput> = z.strictObject({
  changed: z.boolean(),
});

export function toIssuedTokenDto(token: IssuedToken): IssuedTokenDto {
  return {
    expires_at: token.expiresAt === null ? null : token.expiresAt.toISOString(),
    key_id: token.keyId,
    name: token.name,
    role: token.role,
    secret: token.secret,
    tenant_id: token.tenantId.value,
    token_id: token.tokenId,
  };
}

export function toTokenSummaryDto(token: TokenSummary): TokenSummaryDto {
  return {
    created_at: token.createdAt.toISOString(),
    expires_at: token.expiresAt === null ? null : token.expiresAt.toISOString(),
    key_id: token.keyId,
    last_used_at: token.lastUsedAt === null ? null : token.lastUsedAt.toISOString(),
    name: token.name,
    revoked_at: token.revokedAt === null ? null : token.revokedAt.toISOString(),
    role: token.role,
    token_id: token.tokenId,
  };
}

export function toIssuedOperatorTokenDto(token: IssuedOperatorToken): IssuedOperatorTokenDto {
  return {
    expires_at: token.expiresAt === null ? null : token.expiresAt.toISOString(),
    key_id: token.keyId,
    name: token.name,
    secret: token.secret,
    token_id: token.tokenId,
  };
}

export function toOperatorTokenSummaryDto(token: OperatorTokenSummary): OperatorTokenSummaryDto {
  return {
    created_at: token.createdAt.toISOString(),
    expires_at: token.expiresAt === null ? null : token.expiresAt.toISOString(),
    key_id: token.keyId,
    last_used_at: token.lastUsedAt === null ? null : token.lastUsedAt.toISOString(),
    name: token.name,
    revoked_at: token.revokedAt === null ? null : token.revokedAt.toISOString(),
    token_id: token.tokenId,
  };
}

export function toAdminAuditEventDto(event: AdminAuditEvent): AdminAuditEventDto {
  return {
    action: event.action,
    actor_key_id: event.actorKeyId,
    actor_token_id: event.actorTokenId,
    audit_id: event.auditId,
    created_at: event.createdAt.toISOString(),
    metadata: event.metadata,
    target_id: event.targetId,
    target_kind: event.targetKind,
  };
}

export function toTenantSummaryDto(tenant: TenantSummary): TenantSummaryDto {
  return {
    created_at: tenant.createdAt.toISOString(),
    display_name: tenant.displayName,
    slug: tenant.slug,
    status: tenant.status,
    suspended_at: tenant.suspendedAt === null ? null : tenant.suspendedAt.toISOString(),
    tenant_id: tenant.tenantId.value,
  };
}
