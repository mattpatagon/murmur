import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { z } from "zod";

import {
  assertStorageBudgetReconciles,
  type HostedStorageBudget,
  readStorageBudget,
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

function ordinaryLimit(hardLimit: number): number {
  return hardLimit - Math.max(1, Math.floor(hardLimit / 4));
}

async function seedAudit(fixture: StorageBudgetFixture, padding: number): Promise<void> {
  await fixture.admin`
    INSERT INTO murmur.admin_audit(actor_token_id, actor_key_id, action, target_kind, target_id, metadata)
    VALUES (${fixture.actorToken}::uuid, 'headroom_fixture', 'tenant.self_service_create', 'tenant',
      ${fixture.firstTenant}, pg_catalog.jsonb_build_object('padding', repeat('x', ${padding})))
  `;
}

async function fillOrdinaryAllowance(
  fixture: StorageBudgetFixture,
  axis: "bytes" | "rows",
): Promise<HostedStorageBudget> {
  // A small fixed fixture ensures both restrictive actions fit even in an otherwise empty audit.
  await seedAudit(fixture, 8_192);
  const initial: HostedStorageBudget = await readStorageBudget(fixture.admin);
  if (axis === "rows") {
    let hardRows: number = Math.max(12, Math.floor(((initial.audit_rows + 1) * 4) / 3));
    while (ordinaryLimit(hardRows) <= initial.audit_rows) hardRows += 1;
    expect(hardRows).toBeLessThanOrEqual(initial.max_audit_rows);
    await fixture.admin`
      UPDATE murmur.hosted_storage_budget SET max_audit_rows = ${hardRows} WHERE singleton_id = 1
    `;
    for (let count: number = initial.audit_rows; count < ordinaryLimit(hardRows); count += 1) {
      await seedAudit(fixture, 0);
    }
  } else {
    const hardBytes: number = Math.floor(((initial.audit_bytes + 1_024) * 4) / 3);
    expect(hardBytes).toBeLessThanOrEqual(initial.max_audit_bytes);
    const rawCost: unknown = await fixture.admin`
      SELECT murmur.hosted_storage_row_bytes(pg_catalog.jsonb_build_object(
        'actor_token_id', ${fixture.actorToken}::uuid, 'actor_key_id', 'headroom_fixture',
        'action', 'tenant.self_service_create', 'target_kind', 'tenant',
        'target_id', ${fixture.firstTenant}::text, 'metadata', pg_catalog.jsonb_build_object('padding', '')
      )) AS bytes
    `;
    const cost: readonly [{ readonly bytes: number }] = z
      .tuple([z.strictObject({ bytes: z.coerce.number().int().positive().safe() })])
      .parse(rawCost);
    const padding: number = ordinaryLimit(hardBytes) - initial.audit_bytes - cost[0].bytes;
    expect(padding).toBeGreaterThanOrEqual(0);
    expect(padding).toBeLessThan(1_024);
    await fixture.admin`
      UPDATE murmur.hosted_storage_budget SET max_audit_bytes = ${hardBytes} WHERE singleton_id = 1
    `;
    await seedAudit(fixture, padding);
  }
  const filled: HostedStorageBudget = await readStorageBudget(fixture.admin);
  if (axis === "rows") expect(filled.audit_rows).toBe(ordinaryLimit(filled.max_audit_rows));
  else expect(filled.audit_bytes).toBe(ordinaryLimit(filled.max_audit_bytes));
  return filled;
}

async function restrictiveActionsRemainAudited(
  fixture: StorageBudgetFixture,
  operatorId: string,
  operatorKey: string,
  before: HostedStorageBudget,
): Promise<void> {
  await fixture.app`
    SELECT murmur.operator_suspend_tenant(${fixture.operatorHash}, ${fixture.firstTenant}::uuid)
  `;
  await fixture.app`
    SELECT murmur.operator_revoke_operator_token(${fixture.operatorHash}, ${operatorKey})
  `;
  const after: HostedStorageBudget = await readStorageBudget(fixture.admin);
  expect(after.audit_rows).toBe(before.audit_rows + 2);
  expect(after.audit_rows).toBeLessThanOrEqual(after.max_audit_rows);
  expect(after.audit_bytes).toBeLessThanOrEqual(after.max_audit_bytes);
  expect(after.max_audit_rows).toBe(before.max_audit_rows);
  expect(after.max_audit_bytes).toBe(before.max_audit_bytes);
  expect<unknown>(
    await fixture.admin`
    SELECT status FROM murmur.tenants WHERE tenant_id = ${fixture.firstTenant}::uuid
  `,
  ).toEqual([{ status: "suspended" }]);
  expect<unknown>(
    await fixture.admin`
    SELECT revoked_at IS NOT NULL AS revoked FROM murmur.operator_tokens WHERE token_id = ${operatorId}::uuid
  `,
  ).toEqual([{ revoked: true }]);
  expect<unknown>(
    await fixture.admin`
    SELECT action FROM murmur.admin_audit
    WHERE (target_id = ${fixture.firstTenant} AND action = 'tenant.suspend')
      OR (target_id = ${operatorId} AND action = 'operator_token.revoke')
    ORDER BY action
  `,
  ).toEqual([{ action: "operator_token.revoke" }, { action: "tenant.suspend" }]);
}

async function assertUnforgeable(database: Sql, fixture: StorageBudgetFixture): Promise<void> {
  await expect(
    Promise.resolve(database`
    INSERT INTO murmur.admin_audit(actor_token_id, actor_key_id, action, target_kind, target_id)
    VALUES (${fixture.actorToken}::uuid, 'forged', 'tenant.suspend', 'tenant', ${fixture.firstTenant})
  `),
  ).rejects.toHaveProperty("code", "42501");
  await expect(
    Promise.resolve(database`
    SELECT murmur.adjust_hosted_storage_budget_with_audit_headroom('admin_audit', 0::bigint, 0::bigint, true)
  `),
  ).rejects.toHaveProperty("code", "42501");
  expect<unknown>(
    await fixture.admin`
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname IN ('anon', 'authenticated', 'murmur_app')
      AND pg_catalog.has_function_privilege(role.oid,
        'murmur.adjust_hosted_storage_budget_with_audit_headroom(text,bigint,bigint,boolean)', 'EXECUTE')
  `,
  ).toEqual([]);
}

for (const axis of ["bytes", "rows"]) {
  test.skipIf(!storageBudgetTestsEnabled)(
    `ordinary audit ${axis} saturation preserves bounded audited restriction headroom`,
    async (): Promise<void> => {
      if (axis !== "bytes" && axis !== "rows") throw new Error("Invalid test axis");
      await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
        const operatorId: string = randomUUID();
        const operatorKey: string = `Headroom${operatorId.replaceAll("-", "").slice(0, 12)}`;
        try {
          await fixture.admin`
            INSERT INTO murmur.operator_tokens(token_id, key_id, secret_hash, name)
            VALUES (${operatorId}::uuid, ${operatorKey}, ${randomBytes(32)}, 'Headroom revocation target')
          `;
          const filled: HostedStorageBudget = await fillOrdinaryAllowance(fixture, axis);
          // This real ordinary control-plane call writes its own fixed action; callers cannot choose one.
          await expect(
            Promise.resolve(fixture.app`
            SELECT * FROM murmur.operator_list_operator_tokens(${fixture.operatorHash}, NULL::uuid, 1)
          `),
          ).rejects.toHaveProperty("code", "54000");
          expect(await readStorageBudget(fixture.admin)).toEqual(filled);
          await restrictiveActionsRemainAudited(fixture, operatorId, operatorKey, filled);
          const restricted: HostedStorageBudget = await readStorageBudget(fixture.admin);
          // A mixed statement must not let an ordinary event borrow a restrictive event's exemption.
          await expect(
            Promise.resolve(fixture.admin`
            INSERT INTO murmur.admin_audit(actor_token_id, actor_key_id, action, target_kind, target_id)
            SELECT ${fixture.actorToken}::uuid, 'headroom_fixture', action, 'tenant', ${fixture.firstTenant}
            FROM pg_catalog.unnest(ARRAY['tenant.suspend', 'tenant.self_service_create']::text[]) AS action
          `),
          ).rejects.toHaveProperty("code", "54000");
          expect(await readStorageBudget(fixture.admin)).toEqual(restricted);
          await assertUnforgeable(fixture.app, fixture);
          await assertStorageBudgetReconciles(fixture.admin);
          await fixture.admin`
            UPDATE murmur.hosted_storage_budget SET max_audit_rows = audit_rows, max_audit_bytes = audit_bytes
            WHERE singleton_id = 1
          `;
          await expect(
            Promise.resolve(fixture.app`
            SELECT murmur.operator_suspend_tenant(${fixture.operatorHash}, ${fixture.secondTenant}::uuid)
          `),
          ).rejects.toHaveProperty("code", "54000");
          expect<unknown>(
            await fixture.admin`
            SELECT status FROM murmur.tenants WHERE tenant_id = ${fixture.secondTenant}::uuid
          `,
          ).toEqual([{ status: "active" }]);
        } finally {
          await fixture.admin`
            DELETE FROM murmur.admin_audit WHERE target_id = ${operatorId}
              OR actor_token_id IN (SELECT token_id FROM murmur.operator_tokens WHERE secret_hash = ${fixture.operatorHash})
          `;
          await fixture.admin`DELETE FROM murmur.operator_tokens WHERE token_id = ${operatorId}::uuid`;
        }
      });
    },
    30_000,
  );
}
