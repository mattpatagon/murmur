import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

type Connection = Sql | TransactionSql;

async function insertAgent(
  database: Connection,
  identity: string,
  seen: string,
  authority: "peer" | "orchestrator" = "peer",
): Promise<void> {
  await database`
    INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, authority, created_at, last_seen_at)
    VALUES (${FOUNDING_TENANT_ID}::uuid, ${identity}, 'Owner pressure regression', '{}'::jsonb, ${authority},
      ${seen}::timestamptz, ${seen}::timestamptz)
  `;
}

async function rollback(
  database: Sql,
  run: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  const intentional: Error = new Error("Owner retirement rollback");
  try {
    await database.begin(async (transaction: TransactionSql): Promise<void> => {
      await run(transaction);
      throw intentional;
    });
  } catch (error: unknown) {
    if (error !== intentional) throw error;
  }
}

async function assertOpenCount(database: Connection, expected: number): Promise<void> {
  expect<unknown>(
    await database`
    SELECT agent_count::int AS count FROM murmur.tenant_resource_usage
    WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
  `,
  ).toEqual([{ count: expected }]);
}

async function assertClosed(
  database: Connection,
  identity: string,
  closed: boolean,
): Promise<void> {
  expect<unknown>(
    await database`
    SELECT closed_at IS NOT NULL AS closed, generation FROM murmur.agents
    WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${identity}
  `,
  ).toEqual([{ closed, generation: 1 }]);
}

async function fillRealOwnerCapacity(database: TransactionSql, prefix: string): Promise<void> {
  // Keep each setup statement within the real runtime deadline while proving the full row boundary.
  for (let batch: number = 0; batch < 20; batch += 1) {
    await database`
      INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
      SELECT ${FOUNDING_TENANT_ID}::uuid, ${prefix} || ${batch}::text || '-' || ordinal::text,
        'Owner full capacity', '{}'::jsonb, statement_timestamp(), statement_timestamp()
      FROM generate_series(1, least(500, 10000 - (SELECT agent_count::int
        FROM murmur.tenant_resource_usage WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid))) AS ordinal
    `;
  }
}

test.skipIf(!storageBudgetTestsEnabled)(
  "real full owner capacity retires the oldest identity and leases while preserving message generations",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollback(fixture.admin, async (transaction: TransactionSql): Promise<void> => {
        const prefix: string = `pressure-${randomUUID()}`;
        const first: string = `${prefix}-a`;
        const second: string = `${prefix}-b`;
        await insertAgent(transaction, first, "1900-01-01T00:00:00Z");
        await insertAgent(transaction, second, "1900-01-01T00:00:00Z");
        await transaction`
          INSERT INTO murmur.agent_sessions(
            tenant_id, agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at
          ) SELECT ${FOUNDING_TENANT_ID}::uuid, ${first}, 1, identity,
            statement_timestamp(), statement_timestamp(), statement_timestamp() + interval '1 hour'
          FROM unnest(ARRAY['one', 'two']::text[]) AS identity
        `;
        const messageId: string = randomUUID();
        await transaction`SELECT set_config('murmur.tenant_id', ${FOUNDING_TENANT_ID}, true)`;
        await transaction`
          INSERT INTO murmur.messages(
            tenant_id, message_id, thread_id, sender_id, recipient_id, content, created_at, expires_at
          ) VALUES (${FOUNDING_TENANT_ID}::uuid, ${messageId}::uuid, 'pressure-history', ${second},
            ${first}, 'History remains retained', statement_timestamp(),
            statement_timestamp() + interval '30 days')
        `;
        await fillRealOwnerCapacity(transaction, `${prefix}-fill-`);
        await assertOpenCount(transaction, 10000);
        await insertAgent(transaction, `${prefix}-incoming`, "2026-10-14T00:00:00Z");
        await assertOpenCount(transaction, 10000);
        await assertClosed(transaction, first, true);
        await assertClosed(transaction, second, false);
        expect<unknown>(
          await transaction`
          SELECT count(*)::int AS count FROM murmur.agent_sessions
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${first}
            AND ended_at IS NOT NULL AND end_reason = 'closed'
        `,
        ).toEqual([{ count: 2 }]);
        expect<unknown>(
          await transaction`
          SELECT close_reason FROM murmur.agents
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${first}
        `,
        ).toEqual([{ close_reason: "dormant" }]);
        await transaction`
          UPDATE murmur.agents SET closed_at = NULL, close_reason = NULL, last_seen_at = statement_timestamp()
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid AND agent_id = ${first}
        `;
        await assertOpenCount(transaction, 10000);
        await assertClosed(transaction, first, false);
        await assertClosed(transaction, second, true);
        expect<unknown>(
          await transaction`
          SELECT recipient_generation, sender_generation FROM murmur.messages
          WHERE message_id = ${messageId}::uuid
        `,
        ).toEqual([{ recipient_generation: 1, sender_generation: 1 }]);
        await transaction`SELECT murmur.reconcile_hosted_storage_budget()`;
      });
    });
  },
  60_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "owner retirement skips live orchestrator bindings and busy identity locks without waiting",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const prefix: string = `pressure-lock-${randomUUID()}`;
      const protectedId: string = `${prefix}-protected`;
      const busy: string = `${prefix}-busy`;
      const available: string = `${prefix}-available`;
      const rowBusy: string = `${prefix}-row-busy`;
      const leaseBusy: string = `${prefix}-lease-busy`;
      const tokenId: string = randomUUID();
      const locked: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
      const release: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
      let blocking: Promise<void> | null = null;
      try {
        await insertAgent(fixture.admin, protectedId, "1800-01-01T00:00:00Z", "orchestrator");
        await insertAgent(fixture.admin, busy, "1801-01-01T00:00:00Z");
        await insertAgent(fixture.admin, rowBusy, "1802-01-01T00:00:00Z");
        await insertAgent(fixture.admin, leaseBusy, "1803-01-01T00:00:00Z");
        await insertAgent(fixture.admin, available, "1804-01-01T00:00:00Z");
        await fixture.admin`
          INSERT INTO murmur.agent_sessions(tenant_id, agent_id, generation, session_key,
            started_at, last_renewed_at, lease_expires_at)
          VALUES (${FOUNDING_TENANT_ID}::uuid, ${leaseBusy}, 1, 'busy', statement_timestamp(),
            statement_timestamp(), statement_timestamp() + interval '1 hour')
        `;
        await fixture.admin`
          INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name,
            orchestrator_agent_id, personal_id)
          VALUES (${tokenId}::uuid, ${FOUNDING_TENANT_ID}::uuid, ${`Pressure${tokenId.slice(0, 8)}`},
            ${randomBytes(32)}, 'orchestrator', 'Retirement protected binding', ${protectedId}, ${randomUUID()}::uuid)
        `;
        blocking = fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(
            ${FOUNDING_TENANT_ID} || ':' || ${busy}, 671255459461899938::bigint))`;
          await transaction`SELECT 1 FROM murmur.agents WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
            AND agent_id = ${rowBusy} FOR UPDATE`;
          await transaction`SELECT 1 FROM murmur.agent_sessions WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
            AND agent_id = ${leaseBusy} FOR UPDATE`;
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        await rollback(fixture.admin, async (transaction: TransactionSql): Promise<void> => {
          await transaction`UPDATE murmur.tenant_resource_usage SET agent_count = 10000
            WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid`;
          await insertAgent(transaction, `${prefix}-incoming`, "2026-10-14T00:00:00Z");
          await assertOpenCount(transaction, 10000);
          await assertClosed(transaction, protectedId, false);
          await assertClosed(transaction, busy, false);
          await assertClosed(transaction, rowBusy, false);
          await assertClosed(transaction, leaseBusy, false);
          await assertClosed(transaction, available, true);
        });
      } finally {
        release.resolve();
        if (blocking !== null) await blocking;
        await fixture.admin`DELETE FROM murmur.access_tokens WHERE token_id = ${tokenId}::uuid`;
        await fixture.admin`DELETE FROM murmur.agents WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
          AND agent_id IN (${protectedId}, ${busy}, ${rowBusy}, ${leaseBusy}, ${available})`;
      }
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "pressure retirement rolls back with rejected admission and remains private to database triggers",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      await rollback(fixture.admin, async (transaction: TransactionSql): Promise<void> => {
        const prefix: string = `pressure-rollback-${randomUUID()}`;
        await insertAgent(transaction, prefix, "1700-01-01T00:00:00Z");
        await transaction`UPDATE murmur.tenant_resource_usage SET agent_count = 10000
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid`;
        await transaction`UPDATE murmur.hosted_storage_budget SET max_rows = retained_rows
          WHERE singleton_id = 1`;
        await expect(
          transaction.savepoint(async (nested: TransactionSql): Promise<void> => {
            await insertAgent(nested, `${prefix}-incoming`, "2026-10-14T00:00:00Z");
          }),
        ).rejects.toHaveProperty("code", "54000");
        await assertClosed(transaction, prefix, false);
        await assertOpenCount(transaction, 10000);
      });
      await expect(
        Promise.resolve(fixture.app`
        SELECT murmur.retire_owner_agent_for_capacity(${FOUNDING_TENANT_ID}::uuid, 'spoof')
      `),
      ).rejects.toHaveProperty("code", "42501");
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "concurrent owner registrations arbitrate the final slot then retire once without exceeding the cap",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const prefix: string = `pressure-race-${randomUUID()}`;
      const first: string = `${prefix}-old-a`;
      const second: string = `${prefix}-old-b`;
      const newFirst: string = `${prefix}-new-a`;
      const newSecond: string = `${prefix}-new-b`;
      const raw: unknown = await fixture.admin`
        SELECT agent_count::int AS count FROM murmur.tenant_resource_usage
        WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
      `;
      const original: number = z
        .tuple([z.strictObject({ count: z.number().int() })])
        .parse(raw)[0].count;
      try {
        await insertAgent(fixture.admin, first, "1600-01-01T00:00:00Z");
        await insertAgent(fixture.admin, second, "1601-01-01T00:00:00Z");
        await fixture.admin`UPDATE murmur.tenant_resource_usage SET agent_count = 9999
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid`;
        await Promise.all(
          [newFirst, newSecond].map(async (identity: string): Promise<void> => {
            await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
              await transaction`SELECT set_config('murmur.tenant_id', ${FOUNDING_TENANT_ID}, true)`;
              await transaction`SELECT pg_advisory_xact_lock(hashtextextended(
              ${FOUNDING_TENANT_ID} || ':' || ${identity}, 671255459461899938::bigint))`;
              await insertAgent(transaction, identity, "2026-10-14T00:00:00Z");
            });
          }),
        );
        await assertOpenCount(fixture.admin, 10000);
        await assertClosed(fixture.admin, first, true);
        await assertClosed(fixture.admin, second, false);
        await assertClosed(fixture.admin, newFirst, false);
        await assertClosed(fixture.admin, newSecond, false);
      } finally {
        await fixture.admin`DELETE FROM murmur.agents WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
          AND agent_id IN (${first}, ${second}, ${newFirst}, ${newSecond})`;
        await fixture.admin`UPDATE murmur.tenant_resource_usage SET agent_count = ${original}
          WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid`;
      }
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "owner retirement examines at most sixteen busy candidates and does not evict a seventeenth",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const prefix: string = `pressure-bound-${randomUUID()}`;
      const identities: string[] = Array.from(
        { length: 17 },
        (_value: unknown, index: number): string => `${prefix}-${String(index).padStart(2, "0")}`,
      );
      const locked: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
      const release: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
      let blocking: Promise<void> | null = null;
      try {
        for (const identity of identities)
          await insertAgent(fixture.admin, identity, "1500-01-01T00:00:00Z");
        blocking = fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(
            ${FOUNDING_TENANT_ID} || ':' || identity, 671255459461899938::bigint))
            FROM unnest(${fixture.admin.array(identities.slice(0, 16))}::text[]) AS identity`;
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        await rollback(fixture.admin, async (transaction: TransactionSql): Promise<void> => {
          await transaction`UPDATE murmur.tenant_resource_usage SET agent_count = 10000
            WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid`;
          await expect(
            transaction.savepoint(async (nested: TransactionSql): Promise<void> => {
              await insertAgent(nested, `${prefix}-incoming`, "2026-10-14T00:00:00Z");
            }),
          ).rejects.toHaveProperty("code", "54000");
          for (const identity of identities) await assertClosed(transaction, identity, false);
          await assertOpenCount(transaction, 10000);
        });
      } finally {
        release.resolve();
        if (blocking !== null) await blocking;
        await fixture.admin`DELETE FROM murmur.agents WHERE tenant_id = ${FOUNDING_TENANT_ID}::uuid
          AND agent_id = ANY(${fixture.admin.array(identities)}::text[])`;
      }
    });
  },
  30_000,
);
