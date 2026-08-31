import postgres, { type Sql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";
import type { IssuedToken, TenantSummary } from "./control-plane-contracts.js";
import { mapTenant, onlyRow, TenantRowSchema } from "./control-plane-rows.js";
import { issueSelfServiceToken, selfServiceTenantId } from "./token-issuance.js";

export class TenantSlugConflictError extends Error {
  public constructor() {
    super("Tenant slug is already registered");
    this.name = "TenantSlugConflictError";
  }
}

export class TenantRegistrationReplayConflictError extends Error {
  public constructor() {
    super("Registration secret was already used with different tenant details");
    this.name = "RegistrationReplayError";
  }
}

export class TenantRegistrationRateLimitError extends Error {
  public constructor() {
    super("Tenant registration rate limit reached");
    this.name = "TenantRegistrationRateLimitError";
  }
}

export class TenantRegistrationCapacityError extends Error {
  public constructor() {
    super("Tenant registration capacity reached");
    this.name = "TenantRegistrationCapacityError";
  }
}

export class TenantRegistrationBusyError extends Error {
  public constructor() {
    super("Tenant registration is temporarily busy");
    this.name = "TenantRegistrationBusyError";
  }
}

function translateRegistrationError(error: unknown): never {
  if (!(error instanceof postgres.PostgresError)) throw error;
  if (error.code === "23505" && error.constraint_name === "tenants_slug_key") {
    throw new TenantSlugConflictError();
  }
  if (error.code === "23505" || error.code === "P4090") {
    throw new TenantRegistrationReplayConflictError();
  }
  if (error.code === "P4290") throw new TenantRegistrationRateLimitError();
  if (error.code === "P5030") throw new TenantRegistrationCapacityError();
  if (error.code === "55P03") throw new TenantRegistrationBusyError();
  throw error;
}

export async function createSelfServicePostgresTenant(
  database: Sql,
  slug: string,
  displayName: string,
  registrationSecret: string,
): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }> {
  const tenantId: TenantId = selfServiceTenantId(registrationSecret);
  const issued: ReturnType<typeof issueSelfServiceToken> = issueSelfServiceToken(
    tenantId,
    registrationSecret,
  );
  try {
    const rawRows: unknown = await database`
      SELECT
        tenant_id::text AS tenant_id, slug, display_name, status,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        CASE WHEN suspended_at IS NULL THEN NULL ELSE
          to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS suspended_at
      FROM murmur.self_service_create_tenant(
        ${tenantId.value}::uuid,
        ${slug},
        ${displayName},
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash}
      )
    `;
    const tenant: TenantSummary = mapTenant(
      onlyRow(z.array(TenantRowSchema).parse(rawRows), "self-service tenant registration"),
    );
    return { tenant, token: issued.token };
  } catch (error: unknown) {
    translateRegistrationError(error);
  }
}
