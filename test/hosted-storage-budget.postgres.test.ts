import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import type { TransactionSql } from "postgres";

import {
  createSelfServicePostgresTenant,
  TenantRegistrationCapacityError,
} from "../src/hosted/self-service-tenant-control-plane.js";
import { verifyPostgresStorageBudgetSchema } from "../src/storage/postgres-storage-budget-schema.js";
import {
  assertStorageBudgetReconciles,
  type HostedStorageBudget,
  insertStorageMessage,
  readStorageBudget,
  restoreStorageLimits,
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

test.skipIf(!storageBudgetTestsEnabled)(
  "aggregate storage limits atomically arbitrate the final slot across tenants",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const before: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_rows = retained_rows + 1
        WHERE singleton_id = 1
      `;
      const results: PromiseSettledResult<string>[] = await Promise.allSettled([
        insertStorageMessage(fixture.app, fixture.firstTenant),
        insertStorageMessage(fixture.app, fixture.secondTenant),
      ]);
      expect(
        results.filter(
          (result: PromiseSettledResult<string>): boolean => result.status === "fulfilled",
        ),
      ).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          expect(reason).toHaveProperty("code", "54000");
          expect(reason).toHaveProperty("message", "hosted retained-storage capacity reached");
        }
      }
      expect((await readStorageBudget(fixture.admin)).retained_rows).toBe(before.retained_rows + 1);
      await assertStorageBudgetReconciles(fixture.admin);
      await restoreStorageLimits(fixture.admin, before);

      const sampleBefore: HostedStorageBudget = await readStorageBudget(fixture.admin);
      const sample: string = await insertStorageMessage(fixture.app, fixture.firstTenant);
      const sampleBytes: number =
        (await readStorageBudget(fixture.admin)).accounted_bytes - sampleBefore.accounted_bytes;
      await fixture.admin`DELETE FROM murmur.messages WHERE message_id = ${sample}::uuid`;
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_bytes = accounted_bytes + ${sampleBytes}
        WHERE singleton_id = 1
      `;
      const byteResults: PromiseSettledResult<string>[] = await Promise.allSettled([
        insertStorageMessage(fixture.app, fixture.firstTenant),
        insertStorageMessage(fixture.app, fixture.secondTenant),
      ]);
      expect(
        byteResults.filter(
          (result: PromiseSettledResult<string>): boolean => result.status === "fulfilled",
        ),
      ).toHaveLength(1);
      for (const result of byteResults) {
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          expect(reason).toHaveProperty("code", "54000");
        }
      }
      expect((await readStorageBudget(fixture.admin)).accounted_bytes).toBe(
        sampleBefore.accounted_bytes + sampleBytes,
      );
      await assertStorageBudgetReconciles(fixture.admin);
      await restoreStorageLimits(fixture.admin, before);

      const rollbackBefore: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await expect(
        fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`
          INSERT INTO murmur.agent_sessions(
            tenant_id, agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at
          ) VALUES (${fixture.firstTenant}::uuid, 'sender', 1, 'rollback',
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '1 hour')
        `;
          throw new Error("Intentional storage rollback");
        }),
      ).rejects.toThrow("Intentional storage rollback");
      expect(await readStorageBudget(fixture.admin)).toEqual(rollbackBefore);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "metadata byte limits include UTF-8 and admit cleanup and suspension at content capacity",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const message: string = await insertStorageMessage(fixture.app, fixture.firstTenant);
      await fixture.admin`
        UPDATE murmur.agents SET metadata = '{"payload":"x"}'::jsonb
        WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'sender'
      `;
      const ascii: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_bytes = accounted_bytes + 2
        WHERE singleton_id = 1
      `;
      await expect(
        fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
          await transaction`
          UPDATE murmur.agents SET metadata = '{"payload":"🙂"}'::jsonb
          WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'sender'
        `;
        }),
      ).rejects.toHaveProperty("code", "54000");
      expect((await readStorageBudget(fixture.admin)).accounted_bytes).toBe(ascii.accounted_bytes);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_bytes = accounted_bytes + 3
        WHERE singleton_id = 1
      `;
      await fixture.admin`
        UPDATE murmur.agents SET metadata = '{"payload":"🙂"}'::jsonb
        WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'sender'
      `;
      const full: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(full.accounted_bytes).toBe(ascii.accounted_bytes + 3);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_rows = retained_rows WHERE singleton_id = 1
      `;
      await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
        await transaction`SET LOCAL bytea_output = 'escape'`;
        await transaction`
            UPDATE murmur.messages SET read_at = pg_catalog.statement_timestamp()
            WHERE tenant_id = ${fixture.firstTenant}::uuid AND message_id = ${message}::uuid
          `;
        await transaction`
            UPDATE murmur.access_tokens SET revoked_at = pg_catalog.statement_timestamp()
            WHERE tenant_id = ${fixture.firstTenant}::uuid AND token_id = ${fixture.actorToken}::uuid
          `;
      });
      await fixture.app`
        SELECT murmur.operator_suspend_tenant(${fixture.operatorHash}, ${fixture.firstTenant}::uuid)
      `;
      const suspended: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(suspended.accounted_bytes).toBe(full.accounted_bytes);
      expect(suspended.audit_rows).toBe(full.audit_rows + 1);
      expect<unknown>(
        await fixture.admin`
        SELECT status FROM murmur.tenants WHERE tenant_id = ${fixture.firstTenant}::uuid
      `,
      ).toEqual([{ status: "suspended" }]);
      expect<unknown>(
        await fixture.admin`
        SELECT revoked_at IS NOT NULL AS revoked FROM murmur.access_tokens
        WHERE token_id = ${fixture.actorToken}::uuid
      `,
      ).toEqual([{ revoked: true }]);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_rows = 1, max_bytes = 1 WHERE singleton_id = 1
      `;
      await fixture.admin`
        DELETE FROM murmur.messages WHERE tenant_id = ${fixture.firstTenant}::uuid
          AND message_id = ${message}::uuid
      `;
      expect((await readStorageBudget(fixture.admin)).retained_rows).toBe(full.retained_rows - 1);
      await assertStorageBudgetReconciles(fixture.admin);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "plaintext broadcast fan-out and tenant sequence allocation roll back when aggregate capacity is short",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const broadcast: string = randomUUID();
      const sequenceBefore: unknown = await fixture.admin`
        SELECT last_sequence FROM murmur.tenant_message_sequences
        WHERE tenant_id = ${fixture.firstTenant}::uuid
      `;
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_rows = retained_rows + 2 WHERE singleton_id = 1
      `;
      const before: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await expect(
        fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
          await transaction`
          INSERT INTO murmur.broadcasts(
            tenant_id, broadcast_id, thread_id, sender_id, content, repository_name,
            branch_name, client_name, created_at, expires_at
          ) VALUES (${fixture.firstTenant}::uuid, ${broadcast}::uuid, 'budget-broadcast', 'sender',
            'Atomic budget fan-out', 'owner/repository', 'main', 'codex',
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '30 days')
        `;
          await transaction`
          INSERT INTO murmur.messages(
            tenant_id, message_id, thread_id, sender_id, recipient_id, content,
            broadcast_id, created_at, expires_at
          ) SELECT ${fixture.firstTenant}::uuid, pg_catalog.gen_random_uuid(), 'budget-broadcast',
            'sender', recipient, 'Atomic budget fan-out', ${broadcast}::uuid,
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '30 days'
          FROM pg_catalog.unnest(ARRAY['sender', 'recipient']::text[]) AS recipient
        `;
        }),
      ).rejects.toHaveProperty("code", "54000");
      expect(await readStorageBudget(fixture.admin)).toEqual(before);
      expect<unknown>(
        await fixture.admin`
        SELECT last_sequence FROM murmur.tenant_message_sequences
        WHERE tenant_id = ${fixture.firstTenant}::uuid
      `,
      ).toEqual(sequenceBefore);
      expect<unknown>(
        await fixture.admin`
        SELECT broadcast_id FROM murmur.broadcasts WHERE broadcast_id = ${broadcast}::uuid
      `,
      ).toEqual([]);
      await assertStorageBudgetReconciles(fixture.admin);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "budget tables and helpers remain private and all durable tables have accounting triggers",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      expect<unknown>(
        await fixture.admin`
        SELECT relname FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS schema ON schema.oid = relation.relnamespace
        WHERE schema.nspname = 'murmur' AND relation.relkind = 'r'
          AND relation.relname <> 'hosted_storage_budget'
          AND NOT relation.relname = ANY(murmur.hosted_storage_tables())
      `,
      ).toEqual([]);
      expect<unknown>(
        await fixture.admin`
        SELECT relation.relname FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS schema ON schema.oid = relation.relnamespace
        WHERE schema.nspname = 'murmur' AND relation.relname = ANY(murmur.hosted_storage_tables())
          AND (SELECT count(*) FROM pg_catalog.pg_trigger AS trigger
            WHERE trigger.tgrelid = relation.oid AND trigger.tgenabled = 'O'
              AND trigger.tgname LIKE 'account_hosted_storage_%') <> 4
      `,
      ).toEqual([]);
      expect<unknown>(
        await fixture.admin`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class
        WHERE oid = 'murmur.hosted_storage_budget'::regclass
      `,
      ).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
      // Materialize lazy PostgreSQL queries before Bun's rejection matcher inspects them.
      await expect(
        Promise.resolve(fixture.app`SELECT * FROM murmur.hosted_storage_budget`),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        Promise.resolve(
          fixture.app`UPDATE murmur.hosted_storage_budget SET max_bytes = 9999999999`,
        ),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        Promise.resolve(
          fixture.app`SELECT murmur.adjust_hosted_storage_budget('messages', -1, -1)`,
        ),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        Promise.resolve(fixture.app`SELECT murmur.reconcile_hosted_storage_budget()`),
      ).rejects.toHaveProperty("code", "42501");
      expect<unknown>(
        await fixture.admin`
        SELECT role.rolname, procedure.proname FROM pg_catalog.pg_proc AS procedure
        CROSS JOIN pg_catalog.pg_roles AS role
        WHERE procedure.pronamespace = 'murmur'::regnamespace
          AND (procedure.proname LIKE '%hosted_storage%')
          AND role.rolname IN ('anon', 'authenticated', 'murmur_app')
          AND NOT (procedure.proname = 'hosted_storage_budget_ready' AND role.rolname = 'murmur_app')
          AND pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
      `,
      ).toEqual([]);
      await expect(
        fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
          await transaction`
          INSERT INTO murmur.agent_sessions(
            tenant_id, agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at
          ) VALUES (${fixture.secondTenant}::uuid, 'sender', 1, 'foreign',
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '1 hour')
        `;
        }),
      ).rejects.toHaveProperty("code", "42501");
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "full budget registration rolls back tenant, credential, audit and rate state",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await fixture.admin`
        UPDATE murmur.self_service_registration_state
        SET registration_count = 0, window_started_at = pg_catalog.statement_timestamp()
      `;
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_rows = retained_rows WHERE singleton_id = 1
      `;
      const before: HostedStorageBudget = await readStorageBudget(fixture.admin);
      const slug: string = `budget-register-${randomUUID()}`;
      await expect(
        createSelfServicePostgresTenant(
          fixture.app,
          slug,
          "At storage capacity",
          randomBytes(32).toString("base64url"),
        ),
      ).rejects.toBeInstanceOf(TenantRegistrationCapacityError);
      expect(await readStorageBudget(fixture.admin)).toEqual(before);
      expect<unknown>(
        await fixture.admin`SELECT slug FROM murmur.tenants WHERE slug = ${slug}`,
      ).toEqual([]);
      expect<unknown>(
        await fixture.admin`
        SELECT registration_count FROM murmur.self_service_registration_state
      `,
      ).toEqual([{ registration_count: 0 }]);
      await assertStorageBudgetReconciles(fixture.admin);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "audit reserve exhaustion is explicit and owner maintenance restores suspension",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const before: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_audit_bytes = 1 WHERE singleton_id = 1
      `;
      await expect(
        Promise.resolve(fixture.app`
          SELECT murmur.operator_suspend_tenant(${fixture.operatorHash}, ${fixture.firstTenant}::uuid)
        `),
      ).rejects.toHaveProperty("code", "54000");
      expect<unknown>(
        await fixture.admin`
        SELECT status FROM murmur.tenants WHERE tenant_id = ${fixture.firstTenant}::uuid
      `,
      ).toEqual([{ status: "active" }]);
      await restoreStorageLimits(fixture.admin, before);
      await fixture.app`
        SELECT murmur.operator_suspend_tenant(${fixture.operatorHash}, ${fixture.firstTenant}::uuid)
      `;
      expect((await readStorageBudget(fixture.admin)).audit_rows).toBe(before.audit_rows + 1);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "schema readiness refuses missing state, disabled or replaced triggers and unaccounted tables",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await verifyPostgresStorageBudgetSchema(fixture.app);
      const mutations: readonly ((transaction: TransactionSql) => Promise<void>)[] = [
        async (transaction: TransactionSql): Promise<void> => {
          await transaction`ALTER TABLE murmur.agents DISABLE TRIGGER account_hosted_storage_update`;
        },
        async (transaction: TransactionSql): Promise<void> => {
          await transaction`DROP TRIGGER account_hosted_storage_delete ON murmur.agents`;
          await transaction`
            CREATE TRIGGER account_hosted_storage_delete AFTER DELETE ON murmur.agents
            REFERENCING OLD TABLE AS hosted_old_rows FOR EACH STATEMENT
            EXECUTE FUNCTION murmur.account_hosted_storage_truncate()
          `;
        },
        async (transaction: TransactionSql): Promise<void> => {
          await transaction`DELETE FROM murmur.hosted_storage_budget WHERE singleton_id = 1`;
        },
        async (transaction: TransactionSql): Promise<void> => {
          await transaction`DROP FUNCTION murmur.hosted_storage_budget_ready()`;
        },
        async (transaction: TransactionSql): Promise<void> => {
          await transaction`CREATE TABLE murmur.unaccounted_storage_probe (value integer)`;
        },
        async (transaction: TransactionSql): Promise<void> => {
          await transaction`ALTER TABLE murmur.hosted_storage_budget DISABLE ROW LEVEL SECURITY`;
        },
      ];
      for (const mutate of mutations) {
        await expect(
          fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
            await mutate(transaction);
            await expect(verifyPostgresStorageBudgetSchema(transaction)).rejects.toThrow(
              "Murmur's hosted storage budget is unavailable.",
            );
            throw new Error("Rollback budget readiness regression");
          }),
        ).rejects.toThrow("Rollback budget readiness regression");
        await verifyPostgresStorageBudgetSchema(fixture.app);
      }
    });
  },
  30_000,
);
