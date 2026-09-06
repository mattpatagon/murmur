import { expect } from "bun:test";

import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import {
  type HostedStorageBudget,
  readStorageBudget,
  type StorageBudgetFixture,
} from "./hosted-storage-budget.js";

export type UsageCounters = {
  readonly rowBytes: number;
  readonly adjustments: number;
  readonly accounting: number;
  readonly updates: number;
};
const CountSchema: z.ZodType<number> = z.coerce.number().int().nonnegative().safe();
const CountersSchema: z.ZodType<[UsageCounters]> = z.tuple([
  z.strictObject({
    rowBytes: CountSchema,
    adjustments: CountSchema,
    accounting: CountSchema,
    updates: CountSchema,
  }),
]);
type Snapshot = {
  readonly budget: HostedStorageBudget;
  readonly rows: string;
  readonly schema: string;
  readonly routine: string;
};
const FingerprintsSchema: z.ZodType<[{ rows: string; schema: string; routine: string }]> = z.tuple([
  z.strictObject({
    rows: z.string().regex(/^[a-f0-9]{32}$/u),
    schema: z.string().regex(/^[a-f0-9]{32}$/u),
    routine: z.string().regex(/^[a-f0-9]{32}$/u),
  }),
]);

export async function usageCounters(transaction: TransactionSql): Promise<UsageCounters> {
  const raw: unknown = await transaction`
    SELECT
      coalesce((SELECT calls FROM pg_stat_xact_user_functions
        WHERE schemaname = 'murmur' AND funcname = 'hosted_storage_row_bytes'), 0) AS "rowBytes",
      coalesce((SELECT calls FROM pg_stat_xact_user_functions
        WHERE schemaname = 'murmur' AND funcname = 'adjust_hosted_storage_budget_with_audit_headroom'), 0) AS adjustments,
      coalesce((SELECT calls FROM pg_stat_xact_user_functions
        WHERE schemaname = 'murmur' AND funcname = 'account_hosted_storage_change'), 0) AS accounting,
      coalesce((SELECT n_tup_upd FROM pg_stat_xact_user_tables
        WHERE relid = 'murmur.tenant_resource_usage'::regclass), 0) AS updates
  `;
  return CountersSchema.parse(raw)[0];
}

export function expectUsageDelta(
  before: UsageCounters,
  after: UsageCounters,
  expected: UsageCounters,
): void {
  expect({
    rowBytes: after.rowBytes - before.rowBytes,
    adjustments: after.adjustments - before.adjustments,
    accounting: after.accounting - before.accounting,
    updates: after.updates - before.updates,
  }).toEqual(expected);
}

export async function usageRowCharge(
  database: Sql | TransactionSql,
  tenant: string,
): Promise<number> {
  const raw: unknown = await database`
    SELECT murmur.hosted_storage_row_bytes(to_jsonb(usage)) AS bytes
    FROM murmur.tenant_resource_usage AS usage WHERE tenant_id = ${tenant}::uuid
  `;
  return z.tuple([z.strictObject({ bytes: CountSchema })]).parse(raw)[0].bytes;
}

async function snapshot(database: Sql, fixture: StorageBudgetFixture): Promise<Snapshot> {
  const raw: unknown = await database`
    SELECT
      (SELECT md5(coalesce(string_agg(to_jsonb(usage)::text, '' ORDER BY tenant_id), ''))
        FROM murmur.tenant_resource_usage AS usage
        WHERE tenant_id IN (${fixture.firstTenant}::uuid, ${fixture.secondTenant}::uuid)) AS rows,
      (SELECT md5(string_agg(attname::text || ':' || atttypid::text || ':' || attnotnull::text,
          ',' ORDER BY attnum)) FROM pg_attribute
        WHERE attrelid = 'murmur.tenant_resource_usage'::regclass AND attnum > 0 AND NOT attisdropped) AS schema,
      (SELECT md5(pg_get_functiondef(oid) || coalesce(proacl::text, '')) FROM pg_proc
        WHERE oid = 'murmur.account_hosted_storage_change()'::regprocedure) AS routine
  `;
  return { budget: await readStorageBudget(database), ...FingerprintsSchema.parse(raw)[0] };
}

export async function rollbackUsage(
  fixture: StorageBudgetFixture,
  run: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  const before: Snapshot = await snapshot(fixture.admin, fixture);
  const rollback: Error = new Error("Intentional usage accounting rollback");
  try {
    await fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
      await transaction`SET LOCAL track_functions = 'all'`;
      await run(transaction);
      throw rollback;
    });
  } catch (error: unknown) {
    if (error !== rollback) throw error;
  } finally {
    expect(await snapshot(fixture.admin, fixture)).toEqual(before);
  }
}
