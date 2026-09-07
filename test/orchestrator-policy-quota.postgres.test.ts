import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

import { TenantId } from "../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";

const configured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;
const CountSchema: z.ZodType<{ readonly count: number }> = z.strictObject({
  count: z.number().int().nonnegative(),
});

function connectAdmin(): Sql {
  if (adminDatabaseUrl === undefined) throw new Error("Disposable PostgreSQL URL required");
  return postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
}

async function deleteTenant(admin: Sql, tenantId: TenantId): Promise<void> {
  await admin`DELETE FROM murmur.orchestrator_policies WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.access_tokens WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_e2ee_state WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenants WHERE tenant_id = ${tenantId.value}::uuid`;
}

async function writeTargetPolicy(
  writer: Sql,
  tenantId: TenantId,
  tokenId: string,
  instructions: string,
): Promise<unknown> {
  return await writer`INSERT INTO murmur.orchestrator_policies(
      policy_id, tenant_id, scope_kind, scope_owner_id, repository_name, machine_name,
      orchestrator_token_id, instructions, created_by_token_id, updated_by_token_id
    ) VALUES (
      ${randomUUID()}::uuid, ${tenantId.value}::uuid, 'organization', ${tenantId.value}::uuid,
      '', 'quota-race-target', ${tokenId}::uuid, ${instructions}, ${tokenId}::uuid, ${tokenId}::uuid
    ) ON CONFLICT (tenant_id, scope_kind, scope_owner_id, repository_name, machine_name)
    DO UPDATE SET instructions = excluded.instructions, updated_at = statement_timestamp(),
      updated_by_token_id = excluded.updated_by_token_id
    RETURNING policy_id::text`;
}

test.skipIf(!configured)(
  "concurrent same-scope upserts at the policy quota serialize as insert then update",
  async (): Promise<void> => {
    const observer: Sql = connectAdmin();
    const blocker: Sql = connectAdmin();
    const writerA: Sql = connectAdmin();
    const writerB: Sql = connectAdmin();
    const tenantId: TenantId = TenantId.generate();
    const tokenId: string = randomUUID();
    let lockHeld: boolean = false;
    const writes: Promise<unknown>[] = [];
    try {
      await observer`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        VALUES (${tenantId.value}::uuid, ${`quota-race-${tenantId.value}`}, 'Quota race')`;
      await observer`INSERT INTO murmur.access_tokens(
          token_id, tenant_id, key_id, secret_hash, token_role, name,
          personal_id, orchestrator_agent_id
        ) VALUES (
          ${tokenId}::uuid, ${tenantId.value}::uuid, ${tokenId.replaceAll("-", "")},
          ${randomBytes(32)}, 'orchestrator', 'Quota race orchestrator', ${randomUUID()}::uuid,
          'quota-race-orchestrator'
        )`;
      await observer`INSERT INTO murmur.orchestrator_policies(
          policy_id, tenant_id, scope_kind, scope_owner_id, repository_name, machine_name,
          orchestrator_token_id, instructions, created_by_token_id, updated_by_token_id
        ) SELECT gen_random_uuid(), ${tenantId.value}::uuid, 'organization',
          ${tenantId.value}::uuid, '', 'quota-seed-' || lpad(item::text, 4, '0'),
          ${tokenId}::uuid, 'seed', ${tokenId}::uuid, ${tokenId}::uuid
        FROM generate_series(1, 999) AS item`;
      const writerAPid: number = CountSchema.parse(
        (await writerA`SELECT pg_backend_pid()::int AS count`)[0],
      ).count;
      const writerBPid: number = CountSchema.parse(
        (await writerB`SELECT pg_backend_pid()::int AS count`)[0],
      ).count;
      await blocker`SELECT pg_advisory_lock(
        pg_catalog.hashtextextended(${tenantId.value} || ':orchestrator_policies', 0)
      )`;
      lockHeld = true;
      writes.push(writeTargetPolicy(writerA, tenantId, tokenId, "writer-a"));
      writes.push(writeTargetPolicy(writerB, tenantId, tokenId, "writer-b"));
      let waiting: number = 0;
      for (let attempt: number = 0; attempt < 100 && waiting < 2; attempt += 1) {
        waiting = CountSchema.parse(
          (
            await observer`SELECT count(*)::int AS count FROM pg_catalog.pg_locks
              WHERE pid IN (${writerAPid}, ${writerBPid})
                AND locktype = 'advisory' AND NOT granted`
          )[0],
        ).count;
      }
      expect(waiting).toBe(2);
      await blocker`SELECT pg_advisory_unlock(
        pg_catalog.hashtextextended(${tenantId.value} || ':orchestrator_policies', 0)
      )`;
      lockHeld = false;
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(writes);
      expect(results.map((result: PromiseSettledResult<unknown>): string => result.status)).toEqual(
        ["fulfilled", "fulfilled"],
      );
      const count: number = CountSchema.parse(
        (
          await observer`SELECT count(*)::int AS count FROM murmur.orchestrator_policies
            WHERE tenant_id = ${tenantId.value}::uuid`
        )[0],
      ).count;
      expect(count).toBe(1000);
    } finally {
      if (lockHeld) {
        await blocker`SELECT pg_advisory_unlock(
          pg_catalog.hashtextextended(${tenantId.value} || ':orchestrator_policies', 0)
        )`;
      }
      await Promise.allSettled(writes);
      try {
        await deleteTenant(observer, tenantId);
      } finally {
        await Promise.all([
          observer.end({ timeout: 1 }),
          blocker.end({ timeout: 1 }),
          writerA.end({ timeout: 1 }),
          writerB.end({ timeout: 1 }),
        ]);
      }
    }
  },
  30_000,
);
