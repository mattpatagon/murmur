import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type { AgentId } from "../domain/value-objects.js";
import { setPostgresTenantContext } from "../storage/postgres-message-transactions.js";
import type { TenantPrincipal } from "./control-plane-contracts.js";
import {
  type E2eeEntitlementRecord,
  type E2eeTransitionAction,
  type E2eeTransitionResult,
  parseE2eeEntitlementRecord,
} from "./e2ee-entitlement.js";

type EntitlementRow = {
  readonly plaintext_writes_blocked: boolean;
  readonly retained_ciphertext_messages: number;
  readonly state: "enforced" | "off" | "provisioning";
  readonly trust_policy_version: number | null;
  readonly unprovisioned_active_agents: number;
  readonly unread_plaintext_messages: number;
};

const DatabaseIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)), {
    message: "Postgres integer exceeds JavaScript's safe integer range",
  })
  .transform((value: bigint | number | string): number => Number(value));

const EntitlementRowSchema: z.ZodType<EntitlementRow> = z.strictObject({
  plaintext_writes_blocked: z.boolean(),
  retained_ciphertext_messages: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
  state: z.enum(["off", "provisioning", "enforced"]),
  trust_policy_version: DatabaseIntegerSchema.pipe(z.number().positive()).nullable(),
  unprovisioned_active_agents: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
  unread_plaintext_messages: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

export async function getPostgresE2eeEntitlement(
  database: Sql,
  principal: TenantPrincipal,
): Promise<E2eeEntitlementRecord> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<E2eeEntitlementRecord> => {
      await setPostgresTenantContext(transaction, principal.tenantId);
      const rawRows: unknown = await transaction`
        SELECT
          state.state,
          state.plaintext_writes_blocked,
          state.trust_policy_version,
          usage.retained_message_count AS retained_ciphertext_messages,
          (
            SELECT pg_catalog.count(*)
            FROM murmur.agents AS agent
            WHERE agent.tenant_id = ${principal.tenantId.value}::uuid
              AND agent.closed_at IS NULL
              AND EXISTS (
                SELECT 1 FROM murmur.agent_sessions AS session
                WHERE session.tenant_id = agent.tenant_id
                  AND session.agent_id = agent.agent_id
                  AND session.generation = agent.generation
                  AND session.ended_at IS NULL
                  AND session.lease_expires_at > pg_catalog.statement_timestamp()
              )
              AND NOT EXISTS (
                SELECT 1 FROM murmur.e2ee_key_bundles AS bundle
                WHERE bundle.tenant_id = agent.tenant_id
                  AND bundle.agent_id = agent.agent_id
                  AND bundle.agent_generation = agent.generation
              )
          ) AS unprovisioned_active_agents,
          (
            SELECT pg_catalog.count(*)
            FROM murmur.messages AS message
            WHERE message.tenant_id = ${principal.tenantId.value}::uuid
              AND message.read_at IS NULL
          ) AS unread_plaintext_messages
        FROM murmur.tenant_e2ee_state AS state
        JOIN murmur.tenant_e2ee_usage AS usage USING (tenant_id)
        WHERE state.tenant_id = ${principal.tenantId.value}::uuid
      `;
      const rows: EntitlementRow[] = z.array(EntitlementRowSchema).parse(rawRows);
      const row: EntitlementRow | undefined = rows[0];
      if (row === undefined) throw new Error("Tenant E2E entitlement state is unavailable");
      return parseE2eeEntitlementRecord({
        plaintextWritesBlocked: row.plaintext_writes_blocked,
        retainedCiphertextMessages: row.retained_ciphertext_messages,
        state: row.state,
        trustPolicyVersion: row.trust_policy_version,
        unprovisionedActiveAgents: row.unprovisioned_active_agents,
        unreadPlaintextMessages: row.unread_plaintext_messages,
      });
    },
  );
}

export async function resetPostgresE2eeIdentity(
  database: Sql,
  principal: TenantPrincipal,
  agentId: AgentId,
  expectedRootKeyId: string,
  reason: string,
): Promise<boolean> {
  if (principal.role !== "tenant_admin") {
    throw new Error("Tenant administrator authority is required for E2E identity reset");
  }
  const rawRows: unknown = await database`
    SELECT murmur.tenant_reset_e2ee_identity(
      ${principal.tenantId.value}::uuid,
      ${principal.tokenId}::uuid,
      ${agentId.value},
      ${expectedRootKeyId},
      ${reason}
    ) AS changed
  `;
  const rows: { readonly changed: boolean }[] = z
    .array(z.strictObject({ changed: z.boolean() }))
    .parse(rawRows);
  const row: { readonly changed: boolean } | undefined = rows[0];
  if (row === undefined) throw new Error("Tenant E2E identity reset returned no result");
  return row.changed;
}

export async function transitionPostgresE2ee(
  database: Sql,
  principal: TenantPrincipal,
  action: E2eeTransitionAction,
  expectedState: E2eeEntitlementRecord["state"],
  trustPolicyVersion: number | null,
): Promise<E2eeTransitionResult> {
  if (principal.role !== "tenant_admin") {
    throw new Error("Tenant administrator authority is required for E2E transition");
  }
  const rawRows: unknown = await database`
    SELECT murmur.tenant_transition_e2ee(
      ${principal.tenantId.value}::uuid,
      ${principal.tokenId}::uuid,
      ${action},
      ${expectedState},
      ${trustPolicyVersion}::bigint
    ) AS changed
  `;
  const rows: { readonly changed: boolean }[] = z
    .array(z.strictObject({ changed: z.boolean() }))
    .parse(rawRows);
  const row: { readonly changed: boolean } | undefined = rows[0];
  if (row === undefined) throw new Error("Tenant E2E transition returned no result");
  return {
    changed: row.changed,
    entitlement: await getPostgresE2eeEntitlement(database, principal),
  };
}
