import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import type { OrchestratorPolicy, Page } from "./control-plane-contracts.js";
import { mapOrchestratorPolicy, OrchestratorPolicyRowSchema } from "./orchestration-rows.js";

export const MAX_POLICY_PAGE_BYTES: number = 8 * 1024 * 1024;
export const POLICY_PAGE_ROW_BYTES: number = 8 * 1024;
export const POLICY_INSTRUCTIONS_MULTIPLIER: number = 13;
export const PolicyPageLimitSchema: z.ZodNumber = z.number().int().min(1).max(100);

const PageIntegerSchema: z.ZodType<number> = z
  .union([z.number(), z.bigint(), z.string().regex(/^[0-9]{1,16}$/u)])
  .transform((value: bigint | number | string): number => Number(value))
  .pipe(z.number().int().nonnegative().safe());
type BudgetedPolicyRow = {
  readonly policy_id: string;
  readonly page_row: number;
  readonly estimated_page_bytes: number;
  readonly row_json: string | null;
};
const BudgetedPolicyRowSchema: z.ZodType<BudgetedPolicyRow> = z.strictObject({
  policy_id: z.string().uuid(),
  page_row: PageIntegerSchema,
  estimated_page_bytes: PageIntegerSchema,
  row_json: z.string().nullable(),
});

export type BudgetedPolicyPage = {
  readonly bytes: number;
  readonly result: Page<OrchestratorPolicy>;
};

export function parseBudgetedPolicyPage(raw: unknown, limit: number): BudgetedPolicyPage {
  try {
    const boundedLimit: number = PolicyPageLimitSchema.parse(limit);
    const rows: BudgetedPolicyRow[] = z
      .array(BudgetedPolicyRowSchema)
      .max(boundedLimit + 1)
      .parse(raw);
    const items: OrchestratorPolicy[] = [];
    const ids: Set<string> = new Set<string>();
    let bytes: number = 0;
    let hasMore: boolean = false;
    let position: number = 0;
    for (const row of rows) {
      position += 1;
      if (row.page_row !== position || ids.has(row.policy_id))
        throw new Error("Invalid policy page order");
      ids.add(row.policy_id);
      if (row.row_json === null) {
        if (row.estimated_page_bytes !== 0) throw new Error("Invalid policy overflow accounting");
        hasMore = true;
        continue;
      }
      if (hasMore || position > boundedLimit || row.estimated_page_bytes > MAX_POLICY_PAGE_BYTES) {
        throw new Error("Invalid policy fitting prefix");
      }
      const value: unknown = JSON.parse(row.row_json);
      const policy: OrchestratorPolicy = mapOrchestratorPolicy(
        OrchestratorPolicyRowSchema.parse(value),
      );
      const rowBytes: number =
        POLICY_PAGE_ROW_BYTES +
        Buffer.byteLength(policy.instructions, "utf8") * POLICY_INSTRUCTIONS_MULTIPLIER;
      if (
        row.policy_id !== policy.policyId.value ||
        row.estimated_page_bytes !== bytes + rowBytes
      ) {
        throw new Error("Invalid policy payload accounting");
      }
      bytes = row.estimated_page_bytes;
      items.push(policy);
    }
    const last: OrchestratorPolicy | undefined = items.at(-1);
    if (hasMore && last === undefined) throw new Error("Stored policy exceeds its page budget");
    return {
      bytes,
      result: { items, nextCursor: hasMore && last !== undefined ? last.policyId.value : null },
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("orchestration policy page", error);
  }
}
