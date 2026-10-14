import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  assertStorageBudgetReconciles,
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

const CountSchema: z.ZodType<number> = z.coerce.number().int().nonnegative().safe();
const OwnerBudgetSchema: z.ZodType<{
  retained_rows: number;
  accounted_bytes: number;
  owner_rows: number;
  owner_bytes: number;
}> = z.strictObject({
  retained_rows: CountSchema,
  accounted_bytes: CountSchema,
  owner_rows: CountSchema,
  owner_bytes: CountSchema,
});
type OwnerBudget = z.infer<typeof OwnerBudgetSchema>;

async function ownerBudget(database: Sql | TransactionSql): Promise<OwnerBudget> {
  const raw: unknown = await database`
    SELECT retained_rows, accounted_bytes, owner_rows, owner_bytes
    FROM murmur.hosted_storage_budget WHERE singleton_id = 1
  `;
  return z.tuple([OwnerBudgetSchema]).parse(raw)[0];
}

async function rollbackOwner(
  fixture: StorageBudgetFixture,
  run: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  const before: OwnerBudget = await ownerBudget(fixture.admin);
  const rollback: Error = new Error("Intentional owner priority rollback");
  try {
    await fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
      await run(transaction);
      throw rollback;
    });
  } catch (error: unknown) {
    if (error !== rollback) throw error;
  }
  expect(await ownerBudget(fixture.admin)).toEqual(before);
  await assertStorageBudgetReconciles(fixture.admin);
  expect(await ownerBudget(fixture.admin)).toEqual(before);
}

async function ownerAgent(transaction: TransactionSql, identity: string): Promise<void> {
  await transaction`
    INSERT INTO murmur.tenant_message_sequences(tenant_id, last_sequence)
    VALUES (${FOUNDING_TENANT_ID}::uuid, 0) ON CONFLICT DO NOTHING
  `;
  await transaction`
    INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
    VALUES (${FOUNDING_TENANT_ID}::uuid, ${identity}, 'Owner capacity regression', '{}'::jsonb,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp())
  `;
}

async function message(
  transaction: TransactionSql,
  tenant: string,
  identity: string,
): Promise<string> {
  const id: string = randomUUID();
  await transaction`SELECT set_config('murmur.tenant_id', ${tenant}, true)`;
  await transaction`
    INSERT INTO murmur.messages(
      tenant_id, message_id, thread_id, sender_id, recipient_id, content, created_at, expires_at
    ) VALUES (${tenant}::uuid, ${id}::uuid, 'owner-priority', ${identity}, ${identity},
      'Reserved capacity regression', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '30 days')
  `;
  return id;
}

async function rejectedStatement(
  transaction: TransactionSql,
  operation: (nested: TransactionSql) => Promise<unknown>,
): Promise<void> {
  await expect(transaction.savepoint(operation)).rejects.toHaveProperty("code", "54000");
}

test.skipIf(!storageBudgetTestsEnabled)(
  "founding agents exceed the ordinary quota while every tenant retains a finite enforced ceiling",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackOwner(fixture, async (transaction: TransactionSql): Promise<void> => {
        const prefix: string = `owner-${randomUUID()}`;
        await transaction`
          INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
          SELECT ${FOUNDING_TENANT_ID}::uuid, ${prefix} || ordinal::text, 'Owner quota regression',
            '{}'::jsonb, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
          FROM pg_catalog.generate_series(1, 1001) AS ordinal
        `;
        await rejectedStatement(transaction, async (nested: TransactionSql): Promise<void> => {
          await nested`
            INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
            SELECT ${fixture.firstTenant}::uuid, ${prefix} || ordinal::text, 'Ordinary quota regression',
              '{"owner":true,"paid":true}'::jsonb,
              pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
            FROM pg_catalog.generate_series(1, 1001) AS ordinal
          `;
        });
        await transaction`
          UPDATE murmur.tenant_resource_usage SET agent_count = 9999
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
        `;
        await ownerAgent(transaction, `${prefix}-last-open`);
        await ownerAgent(transaction, `${prefix}-over-open`);
        await transaction`
          UPDATE murmur.agents SET closed_at = pg_catalog.statement_timestamp(), close_reason = 'manual'
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${`${prefix}-last-open`}
        `;
        await transaction`
          UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${`${prefix}-last-open`}
        `;
        await transaction`
          UPDATE murmur.agents SET closed_at = pg_catalog.statement_timestamp(), close_reason = 'manual'
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${`${prefix}1`}
        `;
        await transaction`
          UPDATE murmur.tenant_resource_usage SET agent_count = 9999, retained_agent_count = 99999
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
        `;
        await ownerAgent(transaction, `${prefix}-last-retained`);
        await transaction`
          UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${`${prefix}1`}
        `;
        await rejectedStatement(transaction, async (nested: TransactionSql): Promise<void> => {
          await nested`
            INSERT INTO murmur.agents(
              tenant_id, agent_id, display_name, metadata, created_at, last_seen_at, closed_at, close_reason
            ) VALUES (${FOUNDING_TENANT_ID}::uuid, ${`${prefix}-over-retained`}, 'Retained limit',
              '{}'::jsonb, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
              pg_catalog.statement_timestamp(), 'manual')
          `;
        });
      });
    });
  },
  60_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "ordinary tenants cannot consume the owner row reserve and owner writes still obey the global ceiling",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackOwner(fixture, async (transaction: TransactionSql): Promise<void> => {
        const identity: string = `reserve-${randomUUID()}`;
        await ownerAgent(transaction, identity);
        const before: OwnerBudget = await ownerBudget(transaction);
        await transaction`
          UPDATE murmur.hosted_storage_budget SET owner_reserve_enabled = true,
            max_rows = ${before.retained_rows + 3}, owner_reserved_rows = ${before.owner_rows + 2},
            owner_reserved_bytes = 0 WHERE singleton_id = 1
        `;
        await message(transaction, fixture.firstTenant, "sender");
        await rejectedStatement(transaction, async (nested: TransactionSql): Promise<void> => {
          await nested`SELECT pg_catalog.set_config('murmur.owner', 'true', true)`;
          await message(nested, fixture.secondTenant, "sender");
        });
        const first: string = await message(transaction, FOUNDING_TENANT_ID, identity);
        await message(transaction, FOUNDING_TENANT_ID, identity);
        await rejectedStatement(transaction, async (nested: TransactionSql): Promise<void> => {
          await message(nested, FOUNDING_TENANT_ID, identity);
        });
        const full: OwnerBudget = await ownerBudget(transaction);
        expect(full.retained_rows).toBe(before.retained_rows + 3);
        expect(full.owner_rows).toBe(before.owner_rows + 2);
        await transaction`SELECT murmur.reconcile_hosted_storage_budget()`;
        expect(await ownerBudget(transaction)).toEqual(full);
        await transaction`DELETE FROM murmur.messages WHERE message_id = ${first}::uuid`;
        await message(transaction, FOUNDING_TENANT_ID, identity);
        expect(await ownerBudget(transaction)).toEqual(full);
      });
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "owner byte reserve protects UTF-8 content and accounting follows row ownership on mixed changes",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackOwner(fixture, async (transaction: TransactionSql): Promise<void> => {
        const identity: string = `bytes-${randomUUID()}`;
        await ownerAgent(transaction, identity);
        const ordinary: string = await message(transaction, fixture.firstTenant, "sender");
        const owner: string = await message(transaction, FOUNDING_TENANT_ID, identity);
        const before: OwnerBudget = await ownerBudget(transaction);
        await transaction`
          UPDATE murmur.hosted_storage_budget SET owner_reserve_enabled = true,
            max_bytes = ${before.accounted_bytes + 8}, owner_reserved_bytes = ${before.owner_bytes + 4},
            owner_reserved_rows = 0 WHERE singleton_id = 1
        `;
        await transaction`
          UPDATE murmur.messages SET content = content || '🙂' WHERE message_id = ${ordinary}::uuid
        `;
        await rejectedStatement(transaction, async (nested: TransactionSql): Promise<void> => {
          await nested`UPDATE murmur.messages SET content = content || 'x' WHERE message_id = ${ordinary}::uuid`;
        });
        await transaction`
          UPDATE murmur.messages SET content = content || '🙂' WHERE message_id = ${owner}::uuid
        `;
        const full: OwnerBudget = await ownerBudget(transaction);
        expect(full.accounted_bytes).toBe(before.accounted_bytes + 8);
        expect(full.owner_bytes).toBe(before.owner_bytes + 4);
        await rejectedStatement(transaction, async (nested: TransactionSql): Promise<void> => {
          await nested`UPDATE murmur.messages SET content = content || 'x' WHERE message_id = ${owner}::uuid`;
        });
        await transaction`
          UPDATE murmur.messages SET content = content || ''
          WHERE message_id IN (${owner}::uuid, ${ordinary}::uuid)
        `;
        expect(await ownerBudget(transaction)).toEqual(full);
        await transaction`
          DELETE FROM murmur.messages WHERE message_id IN (${owner}::uuid, ${ordinary}::uuid)
        `;
        const removed: OwnerBudget = await ownerBudget(transaction);
        expect(removed.retained_rows).toBe(full.retained_rows - 2);
        expect(removed.owner_rows).toBe(full.owner_rows - 1);
        await transaction`SELECT murmur.reconcile_hosted_storage_budget()`;
        expect(await ownerBudget(transaction)).toEqual(removed);
        await transaction`TRUNCATE murmur.messages`;
        const truncated: OwnerBudget = await ownerBudget(transaction);
        await transaction`SELECT murmur.reconcile_hosted_storage_budget()`;
        expect(await ownerBudget(transaction)).toEqual(truncated);
      });
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "runtime clients cannot enable priority, change reserve counters or invoke its accounting definer",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await expect(
        Promise.resolve(fixture.app`
          UPDATE murmur.hosted_storage_budget SET owner_reserve_enabled = true, owner_rows = 0
        `),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        Promise.resolve(fixture.app`
          SELECT murmur.adjust_hosted_storage_budget_with_owner_reserve('messages', 1, 1, false, 1, 1)
        `),
      ).rejects.toHaveProperty("code", "42501");
    });
  },
  30_000,
);
