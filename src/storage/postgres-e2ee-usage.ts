import type { TransactionSql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";
import type { E2eeTenantUsageDelta } from "./e2ee-usage.js";

const UpdatedRowSchema: z.ZodType<{ readonly tenant_id: string }> = z.strictObject({
  tenant_id: z.string().uuid(),
});

export async function updatePostgresE2eeUsage(
  transaction: TransactionSql,
  tenantId: TenantId,
  delta: E2eeTenantUsageDelta,
): Promise<void> {
  const rawRows: unknown = await transaction`
    UPDATE murmur.tenant_e2ee_usage
    SET
      claim_count = claim_count + ${delta.claimCount},
      pending_broadcast_count = pending_broadcast_count + ${delta.pendingBroadcastCount},
      pending_ciphertext_bytes = pending_ciphertext_bytes + ${delta.pendingCiphertextBytes},
      pending_delivery_count = pending_delivery_count + ${delta.pendingDeliveryCount},
      public_prekey_count = public_prekey_count + ${delta.publicPrekeyCount},
      retained_ciphertext_bytes = retained_ciphertext_bytes + ${delta.retainedCiphertextBytes},
      retained_message_count = retained_message_count + ${delta.retainedMessageCount}
    WHERE tenant_id = ${tenantId.value}::uuid
    RETURNING tenant_id::text AS tenant_id
  `;
  const parsed: z.ZodSafeParseResult<{ readonly tenant_id: string }[]> = z
    .array(UpdatedRowSchema)
    .safeParse(rawRows);
  if (!parsed.success) throw new Error("Tenant E2E usage update returned invalid data");
  const rows: { readonly tenant_id: string }[] = parsed.data;
  if (rows.length !== 1) throw new Error("Tenant E2E usage state is unavailable");
}
