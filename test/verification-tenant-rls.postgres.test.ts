import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { selectVerificationTenant } from "../scripts/select-verification-tenant.js";
import { AgentId, Instant, TenantId } from "../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import { setPostgresTenantContext } from "../src/storage/postgres-message-transactions.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";

const NOW: Instant = Instant.parse("2026-08-04T12:00:00.000Z");
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

async function encryptedRows(app: Sql, context: TenantId, target: TenantId): Promise<unknown> {
  return await app.begin(async (transaction: TransactionSql): Promise<unknown> => {
    await setPostgresTenantContext(transaction, context);
    return await transaction`
      SELECT count(*)::int AS count FROM murmur.e2ee_messages
      WHERE tenant_id = ${target.value}::uuid
    `;
  });
}

test.skipIf(!postgresConfigured)(
  "verification selects a distinct context when the secondary tenant owns ciphertext",
  async (): Promise<void> => {
    if (databaseUrl === undefined || adminDatabaseUrl === undefined)
      throw new Error("Hosted PostgreSQL URLs are required");
    const tenant: TenantId = TenantId.generate();
    const other: TenantId = TenantId.generate();
    const agent: AgentId = AgentId.parse(`verification:${tenant.value}`);
    const admin: Sql = postgres(adminDatabaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
    });
    const app: Sql = postgres(databaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
    });
    try {
      for (const id of [tenant, other]) {
        await admin`
          INSERT INTO murmur.tenants(tenant_id, slug, display_name)
          VALUES (${id.value}::uuid, ${`verification-${id.value}`}, 'Verification tenant test')
        `;
      }
      await admin`
        INSERT INTO murmur.agents(tenant_id, agent_id, display_name, created_at, last_seen_at)
        VALUES (${tenant.value}::uuid, ${agent.value}, ${agent.value},
          ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)
      `;
      await admin`
        INSERT INTO murmur.e2ee_messages(
          tenant_id, tenant_sequence, message_id, thread_id, sender_id, sender_generation,
          sender_authority, message_kind, recipient_id, recipient_generation, idempotency_key,
          pair_counter, envelope_json, sender_chain_json, ciphertext_bytes, created_at, expires_at
        ) VALUES (
          ${tenant.value}::uuid, 1, ${randomUUID()}::uuid, 'verification', ${agent.value}, 1,
          'peer', 'message', ${agent.value}, 1, 'verification', 1, '{}', '{}', 17,
          ${NOW.addDays(-1).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz
        )
      `;
      const role: unknown = await app`
        SELECT current_user AS name, rolsuper, rolbypassrls
        FROM pg_catalog.pg_roles WHERE rolname = current_user
      `;
      expect(role).toEqual([{ name: "murmur_app", rolbypassrls: false, rolsuper: false }]);
      const security: unknown = await app`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class
        WHERE oid = 'murmur.e2ee_messages'::regclass
      `;
      expect(security).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

      // The old secondary-only choice reads its own ciphertext and falsely fails the probe.
      expect(await encryptedRows(app, tenant, tenant)).toEqual([{ count: 1 }]);
      const noContext: unknown = await app`
        SELECT count(*)::int AS count FROM murmur.e2ee_messages
        WHERE tenant_id = ${tenant.value}::uuid
      `;
      expect(noContext).toEqual([{ count: 0 }]);
      const context: TenantId = TenantId.parse(
        selectVerificationTenant(tenant.value, other.value, tenant.value),
      );
      expect(context.value).toBe(other.value);
      expect(await encryptedRows(app, context, tenant)).toEqual([{ count: 0 }]);
    } finally {
      try {
        await app.end({ timeout: 1 });
      } finally {
        try {
          for (const id of [tenant, other]) {
            await admin.begin(async (transaction: TransactionSql): Promise<void> => {
              await transaction`DELETE FROM murmur.e2ee_messages WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${id.value}::uuid`;
            });
          }
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    }
  },
  20_000,
);
