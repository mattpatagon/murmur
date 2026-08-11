import type { Sql } from "postgres";
import { z } from "zod";

import { Instant } from "../domain/value-objects.js";
import type { AdminAuditEvent, OperatorPrincipal } from "./control-plane-contracts.js";
import {
  type AuditRow,
  AuditRowSchema,
  BooleanRowSchema,
  type HostedSchemaProbeRow,
  HostedSchemaProbeRowSchema,
  onlyRow,
} from "./control-plane-rows.js";

export class HostedSchemaNotAppliedError extends Error {
  public constructor() {
    super("Murmur's hosted tenant migration has not been applied");
    // biome-ignore lint/security/noSecrets: Stable error class identifier, not credential material.
    this.name = "HostedSchemaNotAppliedError";
  }
}

export class UnsafeHostedDatabaseRoleError extends Error {
  public constructor() {
    super("Hosted Murmur must connect as the non-owner murmur_app runtime role");
    this.name = "UnsafeHostedDatabaseRoleError";
  }
}

export async function verifyHostedControlPlaneSchema(database: Sql): Promise<void> {
  const rawRows: unknown = await database`
    SELECT
      to_regprocedure('murmur.authenticate_principal(bytea)') IS NOT NULL
      AND to_regprocedure('murmur.authenticate_principal_v2(bytea)') IS NOT NULL
      AND to_regprocedure('murmur.active_credential_hints()') IS NOT NULL
      AND to_regprocedure('murmur.tenant_transition_e2ee(uuid,uuid,text,text,bigint)') IS NOT NULL
      AND to_regprocedure('murmur.tenant_reset_e2ee_identity(uuid,uuid,text,text,text)') IS NOT NULL
      AND to_regclass('murmur.operator_tokens') IS NOT NULL
      AND to_regclass('murmur.orchestrator_policies') IS NOT NULL
      AND to_regclass('murmur.tenant_e2ee_state') IS NOT NULL
      AND to_regclass('murmur.tenant_e2ee_usage') IS NOT NULL AS changed,
      current_user AS current_role,
      role.rolsuper AS is_superuser,
      role.rolbypassrls AS bypasses_rls
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = current_user
  `;
  const rows: HostedSchemaProbeRow[] = z.array(HostedSchemaProbeRowSchema).parse(rawRows);
  const row: HostedSchemaProbeRow = onlyRow(rows, "hosted schema probe");
  if (!row.changed) throw new HostedSchemaNotAppliedError();
  if (row.current_role !== "murmur_app" || row.is_superuser || row.bypasses_rls) {
    throw new UnsafeHostedDatabaseRoleError();
  }
}

export async function hostedHasActiveOperator(database: Sql): Promise<boolean> {
  const rawRows: unknown = await database`
    SELECT murmur.operator_has_active_token() AS changed
  `;
  return onlyRow(z.array(BooleanRowSchema).parse(rawRows), "operator availability").changed;
}

export async function hostedTenantOnboardingEnabled(database: Sql): Promise<boolean> {
  const rawRows: unknown = await database`
    SELECT murmur.tenant_onboarding_enabled() AS changed
  `;
  return onlyRow(z.array(BooleanRowSchema).parse(rawRows), "tenant onboarding capability").changed;
}

export async function listHostedAdminAudit(
  database: Sql,
  principal: OperatorPrincipal,
  limit: number,
): Promise<readonly AdminAuditEvent[]> {
  const rawRows: unknown = await database`
    SELECT
      audit_id, actor_token_id::text AS actor_token_id, actor_key_id,
      action, target_kind, target_id, metadata,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM murmur.operator_list_admin_audit(${principal.credentialHash}, ${limit})
  `;
  return z
    .array(AuditRowSchema)
    .parse(rawRows)
    .map(
      (row: AuditRow): AdminAuditEvent => ({
        action: row.action,
        actorKeyId: row.actor_key_id,
        actorTokenId: row.actor_token_id,
        auditId: row.audit_id,
        createdAt: Instant.parse(row.created_at),
        metadata: row.metadata,
        targetId: row.target_id,
        targetKind: row.target_kind,
      }),
    );
}
