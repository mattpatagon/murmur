import { expect, test } from "bun:test";

import type { TransactionSql } from "postgres";

import { TenantId } from "../src/domain/value-objects.js";
import { MaterializationScope, withMaterializationScope } from "../src/materialization-budget.js";
import { commitPostgresEncryptedBroadcast } from "../src/storage/postgres-e2ee-broadcast-finalize.js";
import { FINALIZE_NOW } from "./support/e2ee-broadcast-finalize-fixture.js";
import {
  type PostgresFinalizeFixture,
  postgresFinalizeConfigured,
  withPostgresFinalizeFixture,
} from "./support/e2ee-postgres-finalize-fixture.js";
import { readStorageBudget } from "./support/hosted-storage-budget.js";

async function commit(fixture: PostgresFinalizeFixture): Promise<unknown> {
  return await withMaterializationScope(
    new MaterializationScope(fixture.budget),
    async (): Promise<unknown> =>
      await commitPostgresEncryptedBroadcast(
        fixture.app,
        fixture.tenantId,
        { broadcast_id: fixture.broadcastId },
        fixture.authorization,
        FINALIZE_NOW,
      ),
  );
}

function payloadQueries(fixture: PostgresFinalizeFixture): readonly string[] {
  return fixture.queries.filter((query: string): boolean =>
    query.includes("envelope_json::text AS envelope_json"),
  );
}

test.skipIf(!postgresFinalizeConfigured)(
  "PostgreSQL commits 100 maximum-size staged envelopes in 25 bounded batches",
  async (): Promise<void> => {
    await withPostgresFinalizeFixture(
      100,
      512 * 1024,
      false,
      async (fixture: PostgresFinalizeFixture): Promise<void> => {
        const started: number = performance.now();
        const rssBefore: number = process.memoryUsage().rss;
        expect(await commit(fixture)).toMatchObject({ duplicate: false, recipient_count: 100 });
        const elapsed: number = performance.now() - started;
        expect(payloadQueries(fixture)).toHaveLength(25);
        const snapshotQueries: readonly string[] = fixture.queries.filter(
          (query: string): boolean => query.includes("AS envelope_bytes"),
        );
        expect(snapshotQueries).toHaveLength(1);
        for (const query of snapshotQueries) {
          expect(query).toContain("FOR UPDATE");
          expect(query).toContain("LIMIT");
          expect(query).not.toContain("AS envelope_json");
        }
        expect(fixture.scratchSamples.some((bytes: number): boolean => bytes > 0)).toBe(true);
        expect(Math.max(...fixture.scratchSamples)).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(fixture.budget.reservedBytes).toBe(0);
        expect<unknown>(
          await fixture.admin`
      SELECT count(*)::int AS count, min(tenant_sequence)::int AS first, max(tenant_sequence)::int AS last
      FROM murmur.e2ee_messages WHERE tenant_id = ${fixture.tenantId.value}::uuid
    `,
        ).toEqual([{ count: 100, first: 1, last: 100 }]);
        expect<unknown>(
          await fixture.admin`
      SELECT retained_message_count::int AS retained, pending_delivery_count::int AS pending,
        pending_ciphertext_bytes::int AS pending_bytes, retained_ciphertext_bytes::int AS retained_bytes
      FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${fixture.tenantId.value}::uuid
    `,
        ).toEqual([
          { pending: 0, pending_bytes: 0, retained: 100, retained_bytes: 100 * (512 * 1024 + 16) },
        ]);
        expect<unknown>(
          await fixture.app.begin(async (transaction: TransactionSql): Promise<unknown> => {
            await transaction`SELECT set_config('murmur.tenant_id', ${TenantId.generate().value}, true)`;
            return await transaction`SELECT recipient_id FROM murmur.e2ee_broadcast_deliveries
        WHERE broadcast_id = ${fixture.broadcastId}::uuid`;
          }),
        ).toEqual([]);
        const queriesBeforeRetry: number = payloadQueries(fixture).length;
        expect(await commit(fixture)).toMatchObject({ duplicate: true, recipient_count: 100 });
        expect(payloadQueries(fixture)).toHaveLength(queriesBeforeRetry);
        process.stdout.write(
          `${JSON.stringify({
            check: "postgres_e2ee_broadcast_100_maximum_envelopes",
            elapsed_ms: Math.round(elapsed),
            payload_batches: 25,
            recipients: 100,
            rss_after_bytes: process.memoryUsage().rss,
            rss_before_bytes: rssBefore,
            scratch_peak_bytes: Math.max(...fixture.scratchSamples),
          })}\n`,
        );
      },
    );
  },
  120_000,
);

test.skipIf(!postgresFinalizeConfigured)(
  "PostgreSQL late batch validation rolls back inserts, sequences, usage and global accounting",
  async (): Promise<void> => {
    await withPostgresFinalizeFixture(
      5,
      512,
      true,
      async (fixture: PostgresFinalizeFixture): Promise<void> => {
        const before: Awaited<ReturnType<typeof readStorageBudget>> = await readStorageBudget(
          fixture.admin,
        );
        await expect(commit(fixture)).rejects.toThrow();
        expect(payloadQueries(fixture)).toHaveLength(2);
        expect(
          fixture.queries.filter((query: string): boolean =>
            query.includes("INSERT INTO murmur.e2ee_messages"),
          ),
        ).toHaveLength(4);
        expect<unknown>(
          await fixture.admin`SELECT count(*)::int AS count FROM murmur.e2ee_messages
      WHERE tenant_id = ${fixture.tenantId.value}::uuid`,
        ).toEqual([{ count: 0 }]);
        expect<unknown>(
          await fixture.admin`SELECT last_sequence::int AS sequence FROM murmur.tenant_message_sequences
      WHERE tenant_id = ${fixture.tenantId.value}::uuid`,
        ).toEqual([{ sequence: 0 }]);
        expect<unknown>(
          await fixture.admin`SELECT state, committed_at FROM murmur.e2ee_broadcasts
      WHERE tenant_id = ${fixture.tenantId.value}::uuid`,
        ).toEqual([{ committed_at: null, state: "pending" }]);
        expect(await readStorageBudget(fixture.admin)).toEqual(before);
        expect(fixture.budget.reservedBytes).toBe(0);
      },
    );
  },
  30_000,
);

test.skipIf(!postgresFinalizeConfigured)(
  "PostgreSQL final usage failure rolls back the entire delivery set and permits recovery",
  async (): Promise<void> => {
    await withPostgresFinalizeFixture(
      5,
      512,
      false,
      async (fixture: PostgresFinalizeFixture): Promise<void> => {
        await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET claim_count = 4 WHERE tenant_id = ${fixture.tenantId.value}::uuid`;
        const before: Awaited<ReturnType<typeof readStorageBudget>> = await readStorageBudget(
          fixture.admin,
        );
        await expect(commit(fixture)).rejects.toHaveProperty("code", "23514");
        expect(
          fixture.queries.filter((query: string): boolean =>
            query.includes("INSERT INTO murmur.e2ee_messages"),
          ),
        ).toHaveLength(5);
        expect<unknown>(
          await fixture.admin`SELECT count(*)::int AS count FROM murmur.e2ee_messages
      WHERE tenant_id = ${fixture.tenantId.value}::uuid`,
        ).toEqual([{ count: 0 }]);
        expect(await readStorageBudget(fixture.admin)).toEqual(before);
        expect(fixture.budget.reservedBytes).toBe(0);
        await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET claim_count = 5 WHERE tenant_id = ${fixture.tenantId.value}::uuid`;
        expect(await commit(fixture)).toMatchObject({ duplicate: false, recipient_count: 5 });
      },
    );
  },
  30_000,
);
