import type { TransactionSql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";

type PostgresE2eeState = "enforced" | "off" | "provisioning";

export async function requirePostgresE2eeWriteState(
  transaction: TransactionSql,
  tenantId: TenantId,
  allowedStates: readonly PostgresE2eeState[],
): Promise<void> {
  const requiredState: PostgresE2eeState | undefined = allowedStates[0];
  if (requiredState === undefined || allowedStates.length > 2) {
    throw new Error("Encrypted write state policy is invalid");
  }
  const alternateState: PostgresE2eeState | null = allowedStates[1] ?? null;
  const raw: unknown = await transaction`
    SELECT murmur.require_tenant_e2ee_write_state(
      ${tenantId.value}::uuid, ${requiredState}, ${alternateState}
    ) AS allowed
  `;
  z.tuple([z.strictObject({ allowed: z.literal(true) })]).parse(raw);
}
