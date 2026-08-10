import { z } from "zod";

import { PersonalId } from "../domain/orchestration.js";
import {
  AgentId,
  Instant,
  type JsonObject,
  JsonObjectSchema,
  RepositoryName,
  TenantId,
} from "../domain/value-objects.js";
import type {
  OperatorTokenSummary,
  Page,
  TenantStatus,
  TenantSummary,
  TenantTokenRole,
  TokenSummary,
} from "./control-plane-contracts.js";

type AuthRow = {
  readonly key_id: string;
  readonly principal_kind: "bootstrap" | "operator" | "tenant";
  readonly tenant_id: string | null;
  readonly token_id: string;
  readonly token_role: TenantTokenRole | null;
};

export type AuthRowV2 = AuthRow & {
  readonly orchestrator_agent_id: string | null;
  readonly personal_id: string | null;
  readonly repository_name: string | null;
};

export type TokenRow = {
  readonly agent_id: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly key_id: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly personal_id: string;
  readonly repository_name: string | null;
  readonly revoked_at: string | null;
  readonly token_id: string;
  readonly token_role: TenantTokenRole;
};

export type OperatorTokenRow = {
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly key_id: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly token_id: string;
};
export type TenantRow = {
  readonly created_at: string;
  readonly display_name: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly suspended_at: string | null;
  readonly tenant_id: string;
};

export type AuditRow = {
  readonly action: string;
  readonly actor_key_id: string;
  readonly actor_token_id: string;
  readonly audit_id: number;
  readonly created_at: string;
  readonly metadata: JsonObject;
  readonly target_id: string;
  readonly target_kind: string;
};

export type HostedSchemaProbeRow = {
  readonly bypasses_rls: boolean;
  readonly changed: boolean;
  readonly current_role: string;
  readonly is_superuser: boolean;
};

export type TokenIdRow = { readonly token_id: string };

export const AuthRowV2Schema: z.ZodType<AuthRowV2> = z.strictObject({
  key_id: z.string(),
  orchestrator_agent_id: z.string().nullable(),
  personal_id: z.string().uuid().nullable(),
  principal_kind: z.enum(["bootstrap", "operator", "tenant"]),
  repository_name: z.string().nullable(),
  tenant_id: z.string().uuid().nullable(),
  token_id: z.string().uuid(),
  token_role: z.enum(["agent", "tenant_admin", "orchestrator"]).nullable(),
});

export const OperatorTokenRowSchema: z.ZodType<OperatorTokenRow> = z.strictObject({
  created_at: z.string(),
  expires_at: z.string().nullable(),
  key_id: z.string(),
  last_used_at: z.string().nullable(),
  name: z.string(),
  revoked_at: z.string().nullable(),
  token_id: z.string().uuid(),
});

export const TokenRowSchema: z.ZodType<TokenRow> = z.strictObject({
  agent_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  key_id: z.string(),
  last_used_at: z.string().nullable(),
  name: z.string(),
  personal_id: z.string().uuid(),
  repository_name: z.string().nullable(),
  revoked_at: z.string().nullable(),
  token_id: z.string().uuid(),
  token_role: z.enum(["agent", "tenant_admin", "orchestrator"]),
});

export const TenantRowSchema: z.ZodType<TenantRow> = z.strictObject({
  created_at: z.string(),
  display_name: z.string(),
  slug: z.string(),
  status: z.enum(["active", "suspended"]),
  suspended_at: z.string().nullable(),
  tenant_id: z.string().uuid(),
});

export const AuditRowSchema: z.ZodType<AuditRow> = z.strictObject({
  action: z.string(),
  actor_key_id: z.string(),
  actor_token_id: z.string().uuid(),
  audit_id: z.coerce.number().int().positive(),
  created_at: z.string(),
  metadata: JsonObjectSchema,
  target_id: z.string(),
  target_kind: z.string(),
});

export const BooleanRowSchema: z.ZodType<{ readonly changed: boolean }> = z.strictObject({
  changed: z.boolean(),
});
export const HostedSchemaProbeRowSchema: z.ZodType<HostedSchemaProbeRow> = z.strictObject({
  bypasses_rls: z.boolean(),
  changed: z.boolean(),
  current_role: z.string(),
  is_superuser: z.boolean(),
});
export const NullableTokenIdRowSchema: z.ZodType<{ readonly token_id: string | null }> =
  z.strictObject({ token_id: z.string().uuid().nullable() });
export const TokenIdRowSchema: z.ZodType<TokenIdRow> = z.strictObject({
  token_id: z.string().uuid(),
});

export function mapOperatorToken(row: OperatorTokenRow): OperatorTokenSummary {
  return {
    createdAt: Instant.parse(row.created_at),
    expiresAt: row.expires_at === null ? null : Instant.parse(row.expires_at),
    keyId: row.key_id,
    lastUsedAt: row.last_used_at === null ? null : Instant.parse(row.last_used_at),
    name: row.name,
    revokedAt: row.revoked_at === null ? null : Instant.parse(row.revoked_at),
    tokenId: row.token_id,
  };
}

export function mapToken(row: TokenRow): TokenSummary {
  return {
    ...mapOperatorToken(row),
    agentId: row.agent_id === null ? null : AgentId.parse(row.agent_id),
    personalId: PersonalId.parse(row.personal_id),
    repositoryName: row.repository_name === null ? null : RepositoryName.parse(row.repository_name),
    role: row.token_role,
  };
}

export function mapTenant(row: TenantRow): TenantSummary {
  return {
    createdAt: Instant.parse(row.created_at),
    displayName: row.display_name,
    slug: row.slug,
    status: row.status,
    suspendedAt: row.suspended_at === null ? null : Instant.parse(row.suspended_at),
    tenantId: TenantId.parse(row.tenant_id),
  };
}

export function onlyRow<T>(rows: readonly T[], name: string): T {
  const row: T | undefined = rows[0];
  if (row === undefined) throw new Error(`${name} returned no row`);
  return row;
}

export function page<T>(
  items: readonly T[],
  limit: number,
  cursorFor: (item: T) => string,
): Page<T> {
  if (items.length <= limit) return { items, nextCursor: null };
  const visible: readonly T[] = items.slice(0, limit);
  const last: T | undefined = visible.at(-1);
  if (last === undefined) return { items: visible, nextCursor: null };
  return { items: visible, nextCursor: cursorFor(last) };
}
