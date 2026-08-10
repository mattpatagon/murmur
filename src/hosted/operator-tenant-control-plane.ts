import type { Sql } from "postgres";
import { z } from "zod";

import { type Instant, TenantId } from "../domain/value-objects.js";
import type {
  IssuedToken,
  OperatorPrincipal,
  Page,
  TenantSummary,
} from "./control-plane-contracts.js";
import {
  BooleanRowSchema,
  mapTenant,
  onlyRow,
  page,
  TenantRowSchema,
} from "./control-plane-rows.js";
import { issueToken } from "./token-issuance.js";

export async function createPostgresTenant(
  database: Sql,
  principal: OperatorPrincipal,
  slug: string,
  displayName: string,
): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }> {
  const tenantId: TenantId = TenantId.generate();
  const issued: ReturnType<typeof issueToken> = issueToken(
    tenantId,
    "tenant_admin",
    "Initial tenant administrator",
    null,
    null,
    null,
    null,
  );
  const rawRows: unknown = await database`
    SELECT
      tenant_id::text AS tenant_id, slug, display_name, status,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      CASE WHEN suspended_at IS NULL THEN NULL ELSE
        to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS suspended_at
    FROM murmur.operator_create_tenant(
      ${principal.credentialHash}, ${tenantId.value}::uuid, ${slug}, ${displayName},
      ${issued.token.tokenId}::uuid, ${issued.token.keyId}, ${issued.hash}, ${issued.token.name}
    )
  `;
  const tenant: TenantSummary = mapTenant(
    onlyRow(z.array(TenantRowSchema).parse(rawRows), "create tenant"),
  );
  return { tenant, token: issued.token };
}

export async function listPostgresTenants(
  database: Sql,
  principal: OperatorPrincipal,
  cursor: string | null,
  limit: number,
): Promise<Page<TenantSummary>> {
  const rawRows: unknown = await database`
    SELECT
      tenant_id::text AS tenant_id, slug, display_name, status,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      CASE WHEN suspended_at IS NULL THEN NULL ELSE
        to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS suspended_at
    FROM murmur.operator_list_tenants(
      ${principal.credentialHash}, ${cursor}::uuid, ${limit + 1}
    )
  `;
  const items: readonly TenantSummary[] = z.array(TenantRowSchema).parse(rawRows).map(mapTenant);
  return page(items, limit, (item: TenantSummary): string => item.tenantId.value);
}

export async function mintPostgresTenantAdminToken(
  database: Sql,
  principal: OperatorPrincipal,
  tenantId: TenantId,
  name: string,
  expiresAt: Instant | null,
): Promise<IssuedToken> {
  const issued: ReturnType<typeof issueToken> = issueToken(
    tenantId,
    "tenant_admin",
    name,
    expiresAt,
    null,
    null,
    null,
  );
  await database`
    SELECT murmur.operator_mint_tenant_admin_token(
      ${principal.credentialHash}, ${tenantId.value}::uuid, ${issued.token.tokenId}::uuid,
      ${issued.token.keyId}, ${issued.hash}, ${name},
      ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz
    )
  `;
  return issued.token;
}

export async function changePostgresTenantStatus(
  database: Sql,
  principal: OperatorPrincipal,
  action: "restore" | "suspend",
  tenantId: TenantId,
): Promise<boolean> {
  const rawRows: unknown =
    action === "suspend"
      ? await database`
          SELECT murmur.operator_suspend_tenant(
            ${principal.credentialHash}, ${tenantId.value}::uuid
          ) AS changed
        `
      : await database`
          SELECT murmur.operator_restore_tenant(
            ${principal.credentialHash}, ${tenantId.value}::uuid
          ) AS changed
        `;
  return onlyRow(z.array(BooleanRowSchema).parse(rawRows), `${action} tenant`).changed;
}
