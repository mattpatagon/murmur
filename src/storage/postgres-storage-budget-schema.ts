import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

const ReadinessRowsSchema: z.ZodType<[{ readonly ready: boolean }]> = z.tuple([
  z.strictObject({ ready: z.boolean() }),
]);

const MISSING_STORAGE_BUDGET: string =
  "Murmur's hosted storage budget is unavailable. Apply the committed Supabase migrations first.";

export async function verifyPostgresStorageBudgetSchema(
  database: Sql | TransactionSql,
): Promise<void> {
  const rawFunction: unknown = await database`
    SELECT pg_catalog.to_regprocedure('murmur.hosted_storage_budget_ready()') IS NOT NULL AS ready
  `;
  if (!ReadinessRowsSchema.parse(rawFunction)[0].ready) {
    throw new Error(MISSING_STORAGE_BUDGET);
  }
  const rawReadiness: unknown =
    await database`SELECT murmur.hosted_storage_budget_ready() AS ready`;
  if (!ReadinessRowsSchema.parse(rawReadiness)[0].ready) {
    throw new Error(MISSING_STORAGE_BUDGET);
  }
}
