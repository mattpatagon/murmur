import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import type { TransactionSql } from "postgres";

import {
  assertStorageBudgetReconciles,
  type HostedStorageBudget,
  readStorageBudget,
  restoreStorageLimits,
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

async function seedCiphertextRows(fixture: StorageBudgetFixture): Promise<string> {
  const broadcast: string = randomUUID();
  const claim: string = randomUUID();
  const prekey: string = `mpk_${"c".repeat(43)}`;
  await fixture.admin`
    INSERT INTO murmur.e2ee_key_bundles(
      tenant_id, agent_id, agent_generation, root_key_id, agent_key_id, bundle_json, published_at
    ) VALUES (${fixture.firstTenant}::uuid, 'recipient', 1, ${`mrk_${"a".repeat(43)}`},
      ${`mak_${"b".repeat(43)}`}, '{"bundle":"retained public bundle"}'::jsonb,
      pg_catalog.statement_timestamp())
  `;
  await fixture.admin`
    INSERT INTO murmur.e2ee_prekeys(
      tenant_id, prekey_id, agent_id, agent_generation, prekey_class,
      certificate_json, published_at, expires_at
    ) VALUES (${fixture.firstTenant}::uuid, ${prekey}, 'recipient', 1, 'one_time',
      '{"certificate":"retained public certificate"}'::jsonb,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '1 hour')
  `;
  await fixture.admin`
    INSERT INTO murmur.e2ee_broadcasts(
      tenant_id, broadcast_id, sender_id, sender_generation, sender_authority,
      thread_id, request_json, recipient_count, state, created_at, expires_at
    ) VALUES (${fixture.firstTenant}::uuid, ${broadcast}::uuid, 'sender', 1, 'peer',
      'storage-budget', '{}'::jsonb, 1, 'pending', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '1 hour')
  `;
  await fixture.admin`
    INSERT INTO murmur.e2ee_claims(
      tenant_id, claim_id, sender_id, sender_generation, recipient_id, recipient_generation,
      prekey_id, message_kind, sender_authority, request_json, claim_json,
      broadcast_id, created_at, expires_at
    ) VALUES (${fixture.firstTenant}::uuid, ${claim}::uuid, 'sender', 1, 'recipient', 1,
      ${prekey}, 'message', 'peer', '{}'::jsonb, '{"claim":"retained claim"}'::jsonb,
      ${broadcast}::uuid, pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '1 hour')
  `;
  await fixture.admin`
    INSERT INTO murmur.e2ee_broadcast_deliveries(
      tenant_id, broadcast_id, recipient_id, recipient_generation, claim_id,
      envelope_json, sender_chain_json, ciphertext_bytes, accepted_at
    ) VALUES (${fixture.firstTenant}::uuid, ${broadcast}::uuid, 'recipient', 1, ${claim}::uuid,
      pg_catalog.jsonb_build_object('ciphertext', pg_catalog.repeat('e', 10000)),
      pg_catalog.jsonb_build_object('chain', pg_catalog.repeat('s', 10000)), 17,
      pg_catalog.statement_timestamp())
  `;
  return broadcast;
}

test.skipIf(!storageBudgetTestsEnabled)(
  "all retained E2EE JSON remains charged across consumption, commit, cancellation and cascades",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const initial: HostedStorageBudget = await readStorageBudget(fixture.admin);
      const broadcast: string = await seedCiphertextRows(fixture);
      const pending: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(pending.retained_rows).toBe(initial.retained_rows + 5);
      expect(pending.accounted_bytes).toBeGreaterThan(initial.accounted_bytes + 20_000);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_bytes = accounted_bytes, max_rows = retained_rows
        WHERE singleton_id = 1
      `;
      await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
        await transaction`
          UPDATE murmur.e2ee_claims SET consumed_at = pg_catalog.statement_timestamp()
          WHERE tenant_id = ${fixture.firstTenant}::uuid
        `;
        await transaction`
          UPDATE murmur.e2ee_prekeys SET retired_at = pg_catalog.statement_timestamp()
          WHERE tenant_id = ${fixture.firstTenant}::uuid
        `;
        await transaction`
          UPDATE murmur.e2ee_broadcasts SET state = 'cancelled'
          WHERE tenant_id = ${fixture.firstTenant}::uuid AND broadcast_id = ${broadcast}::uuid
        `;
        await transaction`
          UPDATE murmur.tenant_e2ee_usage SET pending_ciphertext_bytes = 0, claim_count = 0
          WHERE tenant_id = ${fixture.firstTenant}::uuid
        `;
      });
      const cancelled: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(cancelled.accounted_bytes).toBe(pending.accounted_bytes);
      expect(cancelled.retained_rows).toBe(pending.retained_rows);
      await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
        await transaction`
          DELETE FROM murmur.e2ee_broadcasts
          WHERE tenant_id = ${fixture.firstTenant}::uuid AND broadcast_id = ${broadcast}::uuid
        `;
      });
      expect((await readStorageBudget(fixture.admin)).retained_rows).toBe(
        initial.retained_rows + 2,
      );
      await assertStorageBudgetReconciles(fixture.admin);
      await restoreStorageLimits(fixture.admin, initial);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "ciphertext fan-out reserves both staged and committed copies and rolls back atomically",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const broadcast: string = await seedCiphertextRows(fixture);
      const before: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_rows = retained_rows WHERE singleton_id = 1
      `;
      const insertCommit: () => Promise<void> = async (): Promise<void> => {
        await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
          await transaction`
            UPDATE murmur.e2ee_broadcasts SET state = 'committed', committed_at = pg_catalog.statement_timestamp()
            WHERE tenant_id = ${fixture.firstTenant}::uuid AND broadcast_id = ${broadcast}::uuid
          `;
          await transaction`
            INSERT INTO murmur.e2ee_messages(
              tenant_id, tenant_sequence, message_id, thread_id, sender_id, sender_generation,
              sender_authority, message_kind, recipient_id, recipient_generation, broadcast_id,
              idempotency_key, pair_counter, envelope_json, sender_chain_json, ciphertext_bytes,
              created_at, expires_at
            ) SELECT tenant_id, 1, ${randomUUID()}::uuid, 'storage-budget', 'sender', 1,
              'peer', 'message', recipient_id, recipient_generation, broadcast_id,
              'storage-budget-commit', 1, envelope_json, sender_chain_json, ciphertext_bytes,
              pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '30 days'
            FROM murmur.e2ee_broadcast_deliveries
            WHERE tenant_id = ${fixture.firstTenant}::uuid AND broadcast_id = ${broadcast}::uuid
          `;
        });
      };
      await expect(insertCommit()).rejects.toHaveProperty("code", "54000");
      expect<unknown>(
        await fixture.admin`
        SELECT state FROM murmur.e2ee_broadcasts
        WHERE tenant_id = ${fixture.firstTenant}::uuid AND broadcast_id = ${broadcast}::uuid
      `,
      ).toEqual([{ state: "pending" }]);
      expect((await readStorageBudget(fixture.admin)).accounted_bytes).toBe(before.accounted_bytes);
      await restoreStorageLimits(fixture.admin, before);
      await insertCommit();
      const committed: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(committed.retained_rows).toBe(before.retained_rows + 1);
      expect(committed.accounted_bytes).toBeGreaterThan(before.accounted_bytes + 20_000);
      await assertStorageBudgetReconciles(fixture.admin);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "feedback has an independent included allowance and exact retries do not recharge",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const initial: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await fixture.admin`
        UPDATE murmur.hosted_storage_budget SET max_feedback_rows = feedback_rows + 1
        WHERE singleton_id = 1
      `;
      const first: string = randomUUID();
      const insertFeedback: (id: string) => Promise<void> = async (id: string): Promise<void> => {
        await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${fixture.firstTenant}, true)`;
          await transaction`
            INSERT INTO murmur.feedback_submissions(
              tenant_id, feedback_id, submission_type, reporter_id, reporter_generation,
              repository_name, branch_name, client_name, title, description, created_at
            ) VALUES (${fixture.firstTenant}::uuid, ${id}::uuid, 'issue', 'sender', 1,
              'owner/repository', 'main', 'codex', 'Storage budget', '🙂 feedback',
              pg_catalog.statement_timestamp()) ON CONFLICT DO NOTHING
          `;
        });
      };
      await insertFeedback(first);
      const accepted: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(accepted.feedback_rows).toBe(initial.feedback_rows + 1);
      expect(accepted.retained_rows).toBe(initial.retained_rows + 1);
      expect(accepted.accounted_bytes - initial.accounted_bytes).toBe(
        accepted.feedback_bytes - initial.feedback_bytes,
      );
      await insertFeedback(first);
      expect(await readStorageBudget(fixture.admin)).toEqual(accepted);
      await expect(insertFeedback(randomUUID())).rejects.toHaveProperty("code", "54000");
      await fixture.admin`
        DELETE FROM murmur.feedback_submissions
        WHERE tenant_id = ${fixture.firstTenant}::uuid AND feedback_id = ${first}::uuid
      `;
      const released: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(released.feedback_bytes).toBe(initial.feedback_bytes);
      expect(released.accounted_bytes).toBe(initial.accounted_bytes);
      await assertStorageBudgetReconciles(fixture.admin);
    });
  },
  30_000,
);

test.skipIf(!storageBudgetTestsEnabled)(
  "owner backfill measures populated rows, preserves lowered limits, and detects counter drift",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const before: HostedStorageBudget = await readStorageBudget(fixture.admin);
      await fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`ALTER TABLE murmur.agent_sessions DISABLE TRIGGER account_hosted_storage_insert`;
        await transaction`
          INSERT INTO murmur.agent_sessions(
            tenant_id, agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at
          ) VALUES (${fixture.firstTenant}::uuid, 'sender', 1, 'populated-backfill',
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '1 hour')
        `;
        await transaction`ALTER TABLE murmur.agent_sessions ENABLE TRIGGER account_hosted_storage_insert`;
        await transaction`UPDATE murmur.hosted_storage_budget SET max_rows = 1, max_bytes = 1`;
        await transaction`SELECT murmur.reconcile_hosted_storage_budget()`;
      });
      const backfilled: HostedStorageBudget = await readStorageBudget(fixture.admin);
      expect(backfilled.retained_rows).toBe(before.retained_rows + 1);
      expect(backfilled.accounted_bytes).toBeGreaterThan(before.accounted_bytes + 512);
      expect(backfilled.max_rows).toBe(1);
      expect(backfilled.max_bytes).toBe(1);
      await assertStorageBudgetReconciles(fixture.admin);
      await fixture.admin`
        DELETE FROM murmur.agent_sessions
        WHERE tenant_id = ${fixture.firstTenant}::uuid AND session_key = 'populated-backfill'
      `;
      expect((await readStorageBudget(fixture.admin)).accounted_bytes).toBe(before.accounted_bytes);
      await expect(
        fixture.admin.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`UPDATE murmur.hosted_storage_budget SET retained_rows = 0`;
          await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${fixture.secondTenant}::uuid`;
        }),
      ).rejects.toHaveProperty("code", "XX001");
      expect((await readStorageBudget(fixture.admin)).retained_rows).toBe(before.retained_rows);
    });
  },
  30_000,
);
