import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import {
  AGENT_DORMANCY_DAYS,
  AGENT_GC_DAYS,
  NOTICE_AUDIT_DAYS,
} from "../domain/lifecycle-values.js";
import type { Instant, TenantId } from "../domain/value-objects.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

export type PostgresExpiryQuery = (
  strings: TemplateStringsArray,
  ...parameters: readonly string[]
) => PromiseLike<unknown>;

const CandidateRowsSchema: z.ZodType<readonly [{ readonly candidates: boolean }]> = z.tuple([
  z.strictObject({ candidates: z.boolean() }),
]);

function hasCandidates(raw: unknown): boolean {
  return CandidateRowsSchema.parse(raw)[0].candidates;
}

// This is a fresh snapshot at the caller's clock, never a cached cleanup deadline.
// Broad lifecycle candidates deliberately leave lock-time rechecks to the existing pruner.
export async function queryPostgresPruneCandidates(
  query: PostgresExpiryQuery,
  tenantId: TenantId,
  now: Instant,
): Promise<boolean> {
  const timestamp: string = now.toISOString();
  const dormantCutoff: string = now.addDays(-AGENT_DORMANCY_DAYS).toISOString();
  const gcCutoff: string = now.addDays(-AGENT_GC_DAYS).toISOString();
  const noticeCutoff: string = now.addDays(-NOTICE_AUDIT_DAYS).toISOString();
  return hasCandidates(
    await query`
    SELECT (
      EXISTS (
        SELECT 1 FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid AND expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.broadcasts
        WHERE tenant_id = ${tenantId.value}::uuid AND expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.notices
        WHERE tenant_id = ${tenantId.value}::uuid AND (
          resolved_at <= ${noticeCutoff}::timestamptz
          OR withdrawn_at <= ${noticeCutoff}::timestamptz
          OR (resolved_at IS NULL AND withdrawn_at IS NULL
            AND expires_at <= ${noticeCutoff}::timestamptz)
        )
      ) OR EXISTS (
        SELECT 1 FROM murmur.agent_sessions
        WHERE tenant_id = ${tenantId.value}::uuid
          AND ended_at IS NULL AND lease_expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.agent_sessions
        WHERE tenant_id = ${tenantId.value}::uuid AND ended_at <= ${gcCutoff}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.agents
        WHERE tenant_id = ${tenantId.value}::uuid
          AND closed_at IS NULL AND last_seen_at <= ${dormantCutoff}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.agents
        WHERE tenant_id = ${tenantId.value}::uuid AND closed_at <= ${gcCutoff}::timestamptz
      )
    ) AS candidates
  `,
  );
}

export async function postgresHasPruneCandidates(
  database: Sql,
  tenantId: TenantId,
  now: Instant,
): Promise<boolean> {
  return await database.begin(async (transaction: TransactionSql): Promise<boolean> => {
    await setPostgresTenantContext(transaction, tenantId);
    return await queryPostgresPruneCandidates(transaction, tenantId, now);
  });
}

export async function queryPostgresE2eePruneCandidates(
  query: PostgresExpiryQuery,
  tenantId: TenantId,
  now: Instant,
): Promise<boolean> {
  const timestamp: string = now.toISOString();
  return hasCandidates(
    await query`
    SELECT (
      NOT EXISTS (
        SELECT 1 FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${tenantId.value}::uuid
      ) OR EXISTS (
        SELECT 1 FROM murmur.e2ee_messages
        WHERE tenant_id = ${tenantId.value}::uuid AND expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.e2ee_claims
        WHERE tenant_id = ${tenantId.value}::uuid
          AND broadcast_id IS NULL AND expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.e2ee_broadcasts
        WHERE tenant_id = ${tenantId.value}::uuid AND expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.e2ee_prekeys
        WHERE tenant_id = ${tenantId.value}::uuid
          AND retired_at IS NULL AND claimed_at IS NULL
          AND expires_at <= ${timestamp}::timestamptz
      ) OR EXISTS (
        SELECT 1 FROM murmur.e2ee_prekeys AS prekey
        WHERE prekey.tenant_id = ${tenantId.value}::uuid
          AND (prekey.retired_at IS NOT NULL OR prekey.claimed_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM murmur.e2ee_claims AS claim
            WHERE claim.tenant_id = prekey.tenant_id AND claim.prekey_id = prekey.prekey_id
          )
      )
    ) AS candidates
  `,
  );
}
