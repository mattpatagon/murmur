import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import {
  type HostedStorageBudget,
  readStorageBudget,
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

type Database = Sql | TransactionSql;
type Usage = {
  readonly opened: number;
  readonly retained: number;
  readonly tokens: number;
  readonly actual_opened: number;
  readonly actual_retained: number;
  readonly actual_tokens: number;
};
const CountSchema: z.ZodNumber = z.number().int().nonnegative();
const UsageSchema: z.ZodType<[Usage]> = z.tuple([
  z.strictObject({
    opened: CountSchema,
    retained: CountSchema,
    tokens: CountSchema,
    actual_opened: CountSchema,
    actual_retained: CountSchema,
    actual_tokens: CountSchema,
  }),
]);

async function usage(database: Database, tenant: string): Promise<Usage> {
  const raw: unknown = await database`
    SELECT agent_count::int AS opened, retained_agent_count::int AS retained,
      access_token_count::int AS tokens,
      (SELECT count(*)::int FROM murmur.agents WHERE tenant_id = ${tenant}::uuid AND closed_at IS NULL) AS actual_opened,
      (SELECT count(*)::int FROM murmur.agents WHERE tenant_id = ${tenant}::uuid) AS actual_retained,
      (SELECT count(*)::int FROM murmur.access_tokens WHERE tenant_id = ${tenant}::uuid) AS actual_tokens
    FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenant}::uuid
  `;
  return UsageSchema.parse(raw)[0];
}

function expectIntegrity(state: Usage): void {
  expect(state.opened).toBe(state.actual_opened);
  expect(state.retained).toBe(state.actual_retained);
  expect(state.tokens).toBe(state.actual_tokens);
}

function expectExactDelta(before: Usage, after: Usage): void {
  expect(after.opened - before.opened).toBe(after.actual_opened - before.actual_opened);
  expect(after.retained - before.retained).toBe(after.actual_retained - before.actual_retained);
  expect(after.tokens - before.tokens).toBe(after.actual_tokens - before.actual_tokens);
}

async function rollbackAdmission(
  fixture: StorageBudgetFixture,
  run: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  const before: Usage = await usage(fixture.admin, fixture.firstTenant);
  const otherBefore: Usage = await usage(fixture.admin, fixture.secondTenant);
  const budget: HostedStorageBudget = await readStorageBudget(fixture.admin);
  const rollback: Error = new Error("Intentional quota admission rollback");
  try {
    await fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
      await run(transaction);
      throw rollback;
    });
  } catch (error: unknown) {
    if (error !== rollback) throw error;
  }
  expect(await usage(fixture.admin, fixture.firstTenant)).toEqual(before);
  expect(await usage(fixture.admin, fixture.secondTenant)).toEqual(otherBefore);
  expect(await readStorageBudget(fixture.admin)).toEqual(budget);
}

async function insertAgent(
  database: Database,
  tenant: string,
  identity: string,
  closed: boolean = false,
): Promise<void> {
  await database`
    INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata,
      created_at, last_seen_at, closed_at, close_reason)
    VALUES (${tenant}::uuid, ${identity}, 'Quota admission actor', '{}'::jsonb,
      statement_timestamp(), statement_timestamp(),
      CASE WHEN ${closed} THEN statement_timestamp() ELSE NULL END,
      CASE WHEN ${closed} THEN 'completed' ELSE NULL END)
  `;
}

async function insertToken(database: Database, tenant: string, id: string): Promise<void> {
  await database`
    INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name)
    VALUES (${id}::uuid, ${tenant}::uuid, ${`Quota${id.replaceAll("-", "").slice(0, 24)}`},
      ${randomBytes(32)}, 'agent', 'Quota admission token')
  `;
}

async function runtime(
  fixture: StorageBudgetFixture,
  run: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
    await transaction`SELECT set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
    await run(transaction);
  });
}

for (const statement of ["cte", "merge"]) {
  test.skipIf(!storageBudgetTestsEnabled)(
    `agent ${statement} DELETE/INSERT retains accepted row-trigger admission at capacity`,
    async (): Promise<void> => {
      await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
        await rollbackAdmission(fixture, async (transaction: TransactionSql): Promise<void> => {
          // Exercise the exact admission boundary without materializing 1,000 agents.
          await transaction`UPDATE murmur.tenant_resource_usage SET agent_count = 1000, retained_agent_count = 1000 WHERE tenant_id = ${fixture.firstTenant}::uuid`;
          const before: Usage = await usage(transaction, fixture.firstTenant);
          if (statement === "cte") {
            await transaction`
              WITH removed AS (
                DELETE FROM murmur.agents WHERE tenant_id = ${fixture.firstTenant}::uuid
                  AND agent_id = 'sender' RETURNING tenant_id
              ) INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
              SELECT tenant_id, 'mixed-replacement', 'Mixed replacement', '{}'::jsonb,
                statement_timestamp(), statement_timestamp() FROM removed
            `;
          } else {
            await transaction`
              MERGE INTO murmur.agents AS target
              USING (SELECT * FROM (VALUES ('sender', 1), ('mixed-replacement', 2))
                AS input(identity, position) ORDER BY position) AS source
              ON target.tenant_id = ${fixture.firstTenant}::uuid AND target.agent_id = source.identity
              WHEN MATCHED THEN DELETE
              WHEN NOT MATCHED THEN INSERT(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
                VALUES (${fixture.firstTenant}::uuid, source.identity, 'Mixed replacement', '{}'::jsonb,
                  statement_timestamp(), statement_timestamp())
            `;
          }
          const after: Usage = await usage(transaction, fixture.firstTenant);
          expect(after).toMatchObject({ opened: 1000, retained: 1000, actual_retained: 2 });
          expectExactDelta(before, after);
          expect(
            Array.from(
              await transaction`
            SELECT agent_id FROM murmur.agents WHERE tenant_id = ${fixture.firstTenant}::uuid ORDER BY agent_id
          `,
            ),
          ).toEqual([{ agent_id: "mixed-replacement" }, { agent_id: "recipient" }]);
        });
      });
    },
    30_000,
  );

  test.skipIf(!storageBudgetTestsEnabled)(
    `token ${statement} DELETE/INSERT retains accepted row-trigger admission at capacity`,
    async (): Promise<void> => {
      await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
        await rollbackAdmission(fixture, async (transaction: TransactionSql): Promise<void> => {
          await transaction`UPDATE murmur.tenant_resource_usage SET access_token_count = 1000 WHERE tenant_id = ${fixture.firstTenant}::uuid`;
          const before: Usage = await usage(transaction, fixture.firstTenant);
          const replacement: string = randomUUID();
          const key: string = `Mixed${replacement.replaceAll("-", "").slice(0, 24)}`;
          const hash: Buffer = randomBytes(32);
          if (statement === "cte") {
            await transaction`
              WITH removed AS (
                DELETE FROM murmur.access_tokens WHERE tenant_id = ${fixture.firstTenant}::uuid
                  AND token_id = ${fixture.actorToken}::uuid RETURNING tenant_id
              ) INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name)
              SELECT ${replacement}::uuid, tenant_id, ${key}, ${hash}, 'agent', 'Mixed token replacement'
              FROM removed
            `;
          } else {
            await transaction`
              MERGE INTO murmur.access_tokens AS target
              USING (SELECT * FROM (VALUES (${fixture.actorToken}::uuid, 1), (${replacement}::uuid, 2))
                AS input(identity, position) ORDER BY position) AS source
              ON target.tenant_id = ${fixture.firstTenant}::uuid AND target.token_id = source.identity
              WHEN MATCHED THEN DELETE
              WHEN NOT MATCHED THEN INSERT(token_id, tenant_id, key_id, secret_hash, token_role, name)
                VALUES (source.identity, ${fixture.firstTenant}::uuid, ${key}, ${hash}, 'agent', 'Mixed token replacement')
            `;
          }
          const after: Usage = await usage(transaction, fixture.firstTenant);
          expect(after).toMatchObject({ tokens: 1000, actual_tokens: 1 });
          expectExactDelta(before, after);
          expect(
            Array.from(
              await transaction`
            SELECT token_id::text AS id FROM murmur.access_tokens WHERE tenant_id = ${fixture.firstTenant}::uuid
          `,
            ),
          ).toEqual([{ id: replacement }]);
        });
      });
    },
    30_000,
  );
}

test.skipIf(!storageBudgetTestsEnabled)(
  "separate statements preserve exact open, retained-agent, and token admission caps",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollbackAdmission(fixture, async (transaction: TransactionSql): Promise<void> => {
        await transaction`UPDATE murmur.tenant_resource_usage SET agent_count = 999, retained_agent_count = 999, access_token_count = 999 WHERE tenant_id = ${fixture.firstTenant}::uuid`;
        const before: Usage = await usage(transaction, fixture.firstTenant);
        await insertAgent(transaction, fixture.firstTenant, "cap-agent");
        expect((await usage(transaction, fixture.firstTenant)).opened).toBe(1000);
        await expect(
          transaction.savepoint(async (savepoint: TransactionSql): Promise<void> => {
            await insertAgent(savepoint, fixture.firstTenant, "denied-agent");
          }),
        ).rejects.toMatchObject({ code: "54000", message: "tenant agent quota exceeded" });
        await transaction`UPDATE murmur.agents SET closed_at = statement_timestamp(), close_reason = 'completed' WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'sender'`;
        expect((await usage(transaction, fixture.firstTenant)).opened).toBe(999);
        await insertAgent(transaction, fixture.firstTenant, "replacement-agent");
        await expect(
          transaction.savepoint(async (savepoint: TransactionSql): Promise<void> => {
            await savepoint`UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'sender'`;
          }),
        ).rejects.toMatchObject({ code: "54000", message: "tenant agent quota exceeded" });
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'replacement-agent'`;
        await transaction`UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'sender'`;
        expect((await usage(transaction, fixture.firstTenant)).opened).toBe(1000);
        expectExactDelta(before, await usage(transaction, fixture.firstTenant));

        await transaction`UPDATE murmur.tenant_resource_usage SET retained_agent_count = 9999 WHERE tenant_id = ${fixture.firstTenant}::uuid`;
        const retainedBefore: Usage = await usage(transaction, fixture.firstTenant);
        await insertAgent(transaction, fixture.firstTenant, "closed-cap", true);
        expect((await usage(transaction, fixture.firstTenant)).retained).toBe(10000);
        await expect(
          transaction.savepoint(async (savepoint: TransactionSql): Promise<void> => {
            await insertAgent(savepoint, fixture.firstTenant, "closed-denied", true);
          }),
        ).rejects.toMatchObject({ code: "54000", message: "tenant retained-agent quota exceeded" });
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'closed-cap'`;
        await insertAgent(transaction, fixture.firstTenant, "closed-replacement", true);
        expect((await usage(transaction, fixture.firstTenant)).retained).toBe(10000);
        expectExactDelta(retainedBefore, await usage(transaction, fixture.firstTenant));

        const tokenBefore: Usage = await usage(transaction, fixture.firstTenant);
        const token: string = randomUUID();
        await insertToken(transaction, fixture.firstTenant, token);
        expect((await usage(transaction, fixture.firstTenant)).tokens).toBe(1000);
        await expect(
          transaction.savepoint(async (savepoint: TransactionSql): Promise<void> => {
            await insertToken(savepoint, fixture.firstTenant, randomUUID());
          }),
        ).rejects.toMatchObject({ code: "54000", message: "tenant access-token quota exceeded" });
        await transaction`DELETE FROM murmur.access_tokens WHERE token_id = ${token}::uuid AND tenant_id = ${fixture.firstTenant}::uuid`;
        await insertToken(transaction, fixture.firstTenant, randomUUID());
        expect((await usage(transaction, fixture.firstTenant)).tokens).toBe(1000);
        expectExactDelta(tokenBefore, await usage(transaction, fixture.firstTenant));
      });
    });
  },
  30_000,
);

for (const name of ["enforce_tenant_agent_quota", "enforce_tenant_access_token_quota"]) {
  test.skipIf(!storageBudgetTestsEnabled)(
    `${name} denies runtime direct calls and attachment after its EXECUTE revoke`,
    async (): Promise<void> => {
      await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
        expect(
          Array.from(
            await fixture.admin`
          SELECT role.rolname FROM pg_roles AS role
          WHERE role.rolname IN ('anon', 'authenticated', 'murmur_app')
            AND has_function_privilege(role.oid, ${`murmur.${name}()`}::regprocedure, 'EXECUTE')
        `,
          ),
        ).toEqual([]);
        await expect(
          Promise.resolve(fixture.app`
          SELECT ${fixture.app(`murmur.${name}`)}()
        `),
        ).rejects.toHaveProperty("code", "42501");
        await expect(
          fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
            await transaction`CREATE TEMP TABLE quota_attachment(tenant_id uuid, closed_at timestamptz) ON COMMIT DROP`;
            await transaction`
            CREATE TRIGGER quota_attachment_trigger AFTER INSERT ON quota_attachment
            FOR EACH ROW EXECUTE FUNCTION ${transaction(`murmur.${name}`)}()
          `;
          }),
        ).rejects.toHaveProperty("code", "42501");
      });
    },
    30_000,
  );
}

test.skipIf(!storageBudgetTestsEnabled)(
  "runtime INSERT, close, reopen, and DELETE still fire both original quota triggers",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const before: Usage = await usage(fixture.admin, fixture.firstTenant);
      const token: string = randomUUID();
      await runtime(fixture, async (transaction: TransactionSql): Promise<void> => {
        await insertAgent(transaction, fixture.firstTenant, "runtime-actor");
        await insertToken(transaction, fixture.firstTenant, token);
      });
      const inserted: Usage = await usage(fixture.admin, fixture.firstTenant);
      expect(inserted).toMatchObject({ opened: 3, retained: 3, tokens: 2 });
      expectIntegrity(inserted);
      await runtime(fixture, async (transaction: TransactionSql): Promise<void> => {
        await transaction`UPDATE murmur.agents SET closed_at = statement_timestamp(), close_reason = 'completed' WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'runtime-actor'`;
      });
      const closed: Usage = await usage(fixture.admin, fixture.firstTenant);
      expect(closed).toMatchObject({ opened: 2, retained: 3, tokens: 2 });
      expectIntegrity(closed);
      await runtime(fixture, async (transaction: TransactionSql): Promise<void> => {
        await transaction`UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'runtime-actor'`;
      });
      expect(await usage(fixture.admin, fixture.firstTenant)).toEqual(inserted);
      await runtime(fixture, async (transaction: TransactionSql): Promise<void> => {
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${fixture.firstTenant}::uuid AND agent_id = 'runtime-actor'`;
        await transaction`DELETE FROM murmur.access_tokens WHERE tenant_id = ${fixture.firstTenant}::uuid AND token_id = ${token}::uuid`;
      });
      expect(await usage(fixture.admin, fixture.firstTenant)).toEqual(before);
      expectIntegrity(await usage(fixture.admin, fixture.secondTenant));
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "runtime agent and token DELETE retains foreign rows and their tenant quotas under RLS",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const foreignToken: string = randomUUID();
      await insertToken(fixture.admin, fixture.secondTenant, foreignToken);
      const before: Usage = await usage(fixture.admin, fixture.firstTenant);
      const foreignBefore: Usage = await usage(fixture.admin, fixture.secondTenant);
      await runtime(fixture, async (transaction: TransactionSql): Promise<void> => {
        expect(
          Array.from(
            await transaction`
          DELETE FROM murmur.agents WHERE tenant_id = ${fixture.secondTenant}::uuid RETURNING agent_id
        `,
          ),
        ).toEqual([]);
        expect(
          Array.from(
            await transaction`
          DELETE FROM murmur.agents WHERE agent_id = 'sender' RETURNING tenant_id::text AS tenant
        `,
          ),
        ).toEqual([{ tenant: fixture.firstTenant }]);
        expect(
          Array.from(
            await transaction`
          DELETE FROM murmur.access_tokens WHERE token_id = ${foreignToken}::uuid RETURNING token_id
        `,
          ),
        ).toEqual([]);
        expect(
          Array.from(
            await transaction`
          DELETE FROM murmur.access_tokens WHERE token_id IN (${foreignToken}::uuid, ${fixture.actorToken}::uuid)
          RETURNING tenant_id::text AS tenant
        `,
          ),
        ).toEqual([{ tenant: fixture.firstTenant }]);
      });
      const after: Usage = await usage(fixture.admin, fixture.firstTenant);
      expect(after).toMatchObject({ opened: 1, retained: 1, tokens: 0 });
      expectExactDelta(before, after);
      expectIntegrity(after);
      expect(await usage(fixture.admin, fixture.secondTenant)).toEqual(foreignBefore);
      expectIntegrity(foreignBefore);
    });
  },
  30_000,
);
