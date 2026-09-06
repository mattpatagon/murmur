import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import type { TransactionSql } from "postgres";

import {
  type HostedStorageBudget,
  readStorageBudget,
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";
import {
  expectUsageDelta,
  rollbackUsage,
  type UsageCounters,
  usageCounters,
  usageRowCharge,
} from "./support/hosted-usage-accounting.js";

test.skipIf(!storageBudgetTestsEnabled)(
  "empty and multi-tenant usage UPDATE skips all row-byte calculations and zero-delta adjustments",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackUsage(fixture, async (transaction: TransactionSql): Promise<void> => {
        const budget: HostedStorageBudget = await readStorageBudget(transaction);
        const empty: UsageCounters = await usageCounters(transaction);
        await transaction`UPDATE murmur.tenant_resource_usage SET agent_count = agent_count WHERE false`;
        expectUsageDelta(empty, await usageCounters(transaction), {
          rowBytes: 0,
          adjustments: 0,
          accounting: 1,
          updates: 0,
        });
        const before: UsageCounters = await usageCounters(transaction);
        await transaction`
          UPDATE murmur.tenant_resource_usage SET message_content_bytes = message_content_bytes + 1
          WHERE tenant_id IN (${fixture.firstTenant}::uuid, ${fixture.secondTenant}::uuid)
        `;
        expectUsageDelta(before, await usageCounters(transaction), {
          rowBytes: 0,
          adjustments: 0,
          accounting: 1,
          updates: 2,
        });
        expect(await readStorageBudget(transaction)).toEqual(budget);
        expect(await usageRowCharge(transaction, fixture.firstTenant)).toBe(559);
        expect(await usageRowCharge(transaction, fixture.secondTenant)).toBe(559);
      });
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "single-tenant usage UPDATE preserves fixed bytes while quota values actually change",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackUsage(fixture, async (transaction: TransactionSql): Promise<void> => {
        const budget: HostedStorageBudget = await readStorageBudget(transaction);
        const before: UsageCounters = await usageCounters(transaction);
        await transaction`UPDATE murmur.tenant_resource_usage SET message_count = 1, message_content_bytes = 123 WHERE tenant_id = ${fixture.firstTenant}::uuid`;
        expectUsageDelta(before, await usageCounters(transaction), {
          rowBytes: 0,
          adjustments: 0,
          accounting: 1,
          updates: 1,
        });
        expect<unknown>(
          await transaction`
          SELECT message_count::int AS count, message_content_bytes::int AS bytes
          FROM murmur.tenant_resource_usage WHERE tenant_id = ${fixture.firstTenant}::uuid
        `,
        ).toEqual([{ count: 1, bytes: 123 }]);
        expect(await readStorageBudget(transaction)).toEqual(budget);
      });
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "usage INSERT and DELETE retain their full row and byte charges",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackUsage(fixture, async (transaction: TransactionSql): Promise<void> => {
        const budget: HostedStorageBudget = await readStorageBudget(transaction);
        const beforeDelete: UsageCounters = await usageCounters(transaction);
        await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${fixture.secondTenant}::uuid`;
        expectUsageDelta(beforeDelete, await usageCounters(transaction), {
          rowBytes: 1,
          adjustments: 1,
          accounting: 1,
          updates: 0,
        });
        const deleted: HostedStorageBudget = await readStorageBudget(transaction);
        expect(deleted.retained_rows).toBe(budget.retained_rows - 1);
        expect(deleted.accounted_bytes).toBe(budget.accounted_bytes - 559);
        const beforeInsert: UsageCounters = await usageCounters(transaction);
        await transaction`
          INSERT INTO murmur.tenant_resource_usage(tenant_id, agent_count, retained_agent_count,
            access_token_count, message_count, message_content_bytes, broadcast_count, broadcast_content_bytes)
          VALUES (${fixture.secondTenant}::uuid, 2, 2, 0, 0, 0, 0, 0)
        `;
        expectUsageDelta(beforeInsert, await usageCounters(transaction), {
          rowBytes: 1,
          adjustments: 1,
          accounting: 1,
          updates: 0,
        });
        expect(await readStorageBudget(transaction)).toEqual(budget);
      });
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "additive nullable integer columns remain safely uncharged after catalog changes",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackUsage(fixture, async (transaction: TransactionSql): Promise<void> => {
        await transaction`ALTER TABLE murmur.tenant_resource_usage ADD COLUMN usage_accounting_nullable integer`;
        const budget: HostedStorageBudget = await readStorageBudget(transaction);
        const before: UsageCounters = await usageCounters(transaction);
        await transaction`UPDATE murmur.tenant_resource_usage SET usage_accounting_nullable = 42 WHERE tenant_id = ${fixture.firstTenant}::uuid`;
        expectUsageDelta(before, await usageCounters(transaction), {
          rowBytes: 0,
          adjustments: 0,
          accounting: 1,
          updates: 1,
        });
        expect(await usageRowCharge(transaction, fixture.firstTenant)).toBe(559);
        expect(await usageRowCharge(transaction, fixture.secondTenant)).toBe(559);
        expect(await readStorageBudget(transaction)).toEqual(budget);
      });
    });
  },
  30_000,
);

for (const shape of ["text", "jsonb", "numeric"]) {
  test.skipIf(!storageBudgetTestsEnabled)(
    `added ${shape} payload falls back to exact accounting and rejects over-cap growth atomically`,
    async (): Promise<void> => {
      await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
        await rollbackUsage(fixture, async (transaction: TransactionSql): Promise<void> => {
          await transaction`ALTER TABLE murmur.tenant_resource_usage ADD COLUMN usage_accounting_payload ${transaction(shape)}`;
          const budget: HostedStorageBudget = await readStorageBudget(transaction);
          const initialCharge: number = await usageRowCharge(transaction, fixture.firstTenant);
          expect(initialCharge).toBe(559);
          const before: UsageCounters = await usageCounters(transaction);
          if (shape === "text") {
            await transaction`UPDATE murmur.tenant_resource_usage SET usage_accounting_payload = ${"\u0001".repeat(8)} WHERE tenant_id = ${fixture.firstTenant}::uuid`;
          } else if (shape === "jsonb") {
            await transaction`UPDATE murmur.tenant_resource_usage SET usage_accounting_payload = jsonb_build_object('charged', repeat('x', 32)) WHERE tenant_id = ${fixture.firstTenant}::uuid`;
          } else {
            await transaction`UPDATE murmur.tenant_resource_usage SET usage_accounting_payload = 'NaN'::numeric WHERE tenant_id = ${fixture.firstTenant}::uuid`;
          }
          expectUsageDelta(before, await usageCounters(transaction), {
            rowBytes: 2,
            adjustments: 1,
            accounting: 1,
            updates: 1,
          });
          const changed: HostedStorageBudget = await readStorageBudget(transaction);
          const changedCharge: number = await usageRowCharge(transaction, fixture.firstTenant);
          expect(changedCharge).toBeGreaterThan(initialCharge);
          expect(changed.accounted_bytes - budget.accounted_bytes).toBe(
            changedCharge - initialCharge,
          );
          expect(changed.retained_rows).toBe(budget.retained_rows);
          if (shape === "numeric") {
            expect<unknown>(
              await transaction`
              SELECT jsonb_typeof(to_jsonb(usage_accounting_payload)) AS kind
              FROM murmur.tenant_resource_usage WHERE tenant_id = ${fixture.firstTenant}::uuid
            `,
            ).toEqual([{ kind: "string" }]);
          }
          await transaction`UPDATE murmur.hosted_storage_budget SET max_bytes = accounted_bytes WHERE singleton_id = 1`;
          const capped: HostedStorageBudget = await readStorageBudget(transaction);
          await expect(
            transaction.savepoint(async (savepoint: TransactionSql): Promise<void> => {
              if (shape === "text") {
                await savepoint`UPDATE murmur.tenant_resource_usage SET usage_accounting_payload = ${"\u0001".repeat(9)} WHERE tenant_id = ${fixture.firstTenant}::uuid`;
              } else if (shape === "jsonb") {
                await savepoint`UPDATE murmur.tenant_resource_usage SET usage_accounting_payload = jsonb_build_object('charged', repeat('x', 64)) WHERE tenant_id = ${fixture.firstTenant}::uuid`;
              } else {
                await savepoint`UPDATE murmur.tenant_resource_usage SET usage_accounting_payload = 'Infinity'::numeric WHERE tenant_id = ${fixture.firstTenant}::uuid`;
              }
            }),
          ).rejects.toMatchObject({
            code: "54000",
            message: "hosted retained-storage capacity reached",
          });
          expect(await readStorageBudget(transaction)).toEqual(capped);
          expect(await usageRowCharge(transaction, fixture.firstTenant)).toBe(changedCharge);
        });
      });
    },
    30_000,
  );
}

test.skipIf(!storageBudgetTestsEnabled)(
  "runtime RLS and original agent/token quota admission still operate after definer EXECUTE revocation",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`SELECT set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
        expect<unknown>(await transaction`SELECT current_user AS role`).toEqual([
          { role: "murmur_app" },
        ]);
        expect<unknown>(
          await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${fixture.secondTenant}::uuid RETURNING agent_id`,
        ).toEqual([]);
        await transaction`
          INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
          VALUES (${fixture.firstTenant}::uuid, 'usage-permission', 'Usage permission', '{}'::jsonb,
            statement_timestamp(), statement_timestamp())
        `;
        await transaction`UPDATE murmur.agents SET closed_at = statement_timestamp(), close_reason = 'completed' WHERE agent_id = 'usage-permission'`;
        await transaction`UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL WHERE agent_id = 'usage-permission'`;
        await transaction`DELETE FROM murmur.agents WHERE agent_id = 'usage-permission'`;
        const token: string = randomUUID();
        await transaction`
          INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name)
          VALUES (${token}::uuid, ${fixture.firstTenant}::uuid, ${`Usage${token.replaceAll("-", "").slice(0, 24)}`},
            ${randomBytes(32)}, 'agent', 'Usage permission')
        `;
        await transaction`DELETE FROM murmur.access_tokens WHERE token_id = ${token}::uuid`;
      });
      expect<unknown>(
        await fixture.admin`
        SELECT agent_count::int AS opened, retained_agent_count::int AS retained
        FROM murmur.tenant_resource_usage
        WHERE tenant_id IN (${fixture.firstTenant}::uuid, ${fixture.secondTenant}::uuid)
        ORDER BY tenant_id
      `,
      ).toEqual([
        { opened: 2, retained: 2 },
        { opened: 2, retained: 2 },
      ]);
      expect<unknown>(
        await fixture.admin`SELECT access_token_count::int AS tokens FROM murmur.tenant_resource_usage WHERE tenant_id = ${fixture.firstTenant}::uuid`,
      ).toEqual([{ tokens: 1 }]);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "fixed UUID charge is catalog-backed and accounting/quota functions remain private definers",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      expect<unknown>(
        await fixture.admin`
        SELECT atttypid = 'uuid'::regtype AS uuid, attnotnull AS nonnull
        FROM pg_attribute WHERE attrelid = 'murmur.tenant_resource_usage'::regclass
          AND attname = 'tenant_id' AND attnum > 0 AND NOT attisdropped
      `,
      ).toEqual([{ uuid: true, nonnull: true }]);
      expect(await usageRowCharge(fixture.admin, fixture.firstTenant)).toBe(559);
      expect<unknown>(
        await fixture.admin`
        SELECT prosecdef AS definer, proconfig @> ARRAY['search_path=""', 'bytea_output=hex']::text[] AS settings
        FROM pg_proc WHERE oid = 'murmur.account_hosted_storage_change()'::regprocedure
      `,
      ).toEqual([{ definer: true, settings: true }]);
      const routines: readonly string[] = [
        "account_hosted_storage_change",
        "enforce_tenant_agent_quota",
        "enforce_tenant_access_token_quota",
      ];
      expect<unknown>(
        await fixture.admin`
        SELECT role.rolname, routine.proname FROM pg_roles AS role CROSS JOIN pg_proc AS routine
        WHERE role.rolname IN ('anon', 'authenticated', 'murmur_app')
          AND routine.pronamespace = 'murmur'::regnamespace
          AND routine.proname = ANY(${fixture.admin.array([...routines])}::text[])
          AND has_function_privilege(role.oid, routine.oid, 'EXECUTE')
      `,
      ).toEqual([]);
      for (const routine of routines) {
        await expect(
          Promise.resolve(fixture.app`SELECT ${fixture.app(`murmur.${routine}`)}()`),
        ).rejects.toHaveProperty("code", "42501");
        await expect(
          fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
            await transaction`CREATE TEMP TABLE usage_attachment(tenant_id uuid) ON COMMIT DROP`;
            await transaction`
            CREATE TRIGGER usage_attachment_trigger AFTER INSERT ON usage_attachment
            FOR EACH ROW EXECUTE FUNCTION ${transaction(`murmur.${routine}`)}()
          `;
          }),
        ).rejects.toHaveProperty("code", "42501");
      }
    });
  },
  30_000,
);
