import { randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";

import { TenantId } from "../../src/domain/value-objects.js";
import { MaterializationByteBudget } from "../../src/materialization-budget.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../../src/postgres-runtime.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import type { E2eeWriteAuthorization } from "../../src/storage/e2ee-message-store.js";
import {
  FINALIZE_AUTHORIZATION,
  FINALIZE_NOW,
  type FinalizeFixtureDelivery,
  finalizeFixtureDeliveries,
  finalizeSenderChain,
} from "./e2ee-broadcast-finalize-fixture.js";
import { adminDatabaseUrl, databaseUrl, testTlsConfiguration } from "./hosted-mcp-harness.js";

export const postgresFinalizeConfigured: boolean =
  databaseUrl !== undefined && adminDatabaseUrl !== undefined;

export type PostgresFinalizeFixture = {
  readonly admin: Sql;
  readonly app: Sql;
  readonly authorization: E2eeWriteAuthorization;
  readonly broadcastId: string;
  readonly budget: MaterializationByteBudget;
  readonly prefix: string;
  readonly queries: string[];
  readonly scratchSamples: number[];
  readonly tenantId: TenantId;
};

async function seedDelivery(
  transaction: TransactionSql,
  fixture: PostgresFinalizeFixture,
  index: number,
  paddedLength: number,
  invalidChain: boolean,
): Promise<void> {
  const delivery: FinalizeFixtureDelivery | undefined = finalizeFixtureDeliveries(
    fixture.broadcastId,
    1,
    fixture.tenantId.value,
    paddedLength,
    index,
    fixture.prefix,
  )[0];
  if (delivery === undefined) throw new Error("Broadcast delivery fixture is missing");
  const prekey: string = `mpk_${Buffer.alloc(32, index).toString("base64url")}`;
  await transaction`
    INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
    VALUES (${fixture.tenantId.value}::uuid, ${delivery.recipientId}, ${delivery.recipientId}, '{}',
      ${FINALIZE_NOW.toISOString()}::timestamptz, ${FINALIZE_NOW.toISOString()}::timestamptz)
  `;
  await transaction`
    INSERT INTO murmur.e2ee_key_bundles(tenant_id, agent_id, agent_generation, root_key_id,
      agent_key_id, bundle_json, published_at)
    VALUES (${fixture.tenantId.value}::uuid, ${delivery.recipientId}, 1, ${`mrk_${"e".repeat(43)}`},
      ${`mak_${"c".repeat(43)}`}, '{}', ${FINALIZE_NOW.toISOString()}::timestamptz)
  `;
  await transaction`
    INSERT INTO murmur.e2ee_prekeys(tenant_id, prekey_id, agent_id, agent_generation, prekey_class,
      certificate_json, published_at, expires_at)
    VALUES (${fixture.tenantId.value}::uuid, ${prekey}, ${delivery.recipientId}, 1, 'fallback', '{}',
      ${FINALIZE_NOW.toISOString()}::timestamptz, ${FINALIZE_NOW.addDays(1).toISOString()}::timestamptz)
  `;
  await transaction`
    INSERT INTO murmur.e2ee_claims(tenant_id, claim_id, sender_id, sender_generation,
      recipient_id, recipient_generation, prekey_id, message_kind, sender_authority,
      request_json, claim_json, broadcast_id, created_at, expires_at, consumed_at)
    VALUES (${fixture.tenantId.value}::uuid, ${delivery.claimId}::uuid, ${`${fixture.prefix}sender`}, 1,
      ${delivery.recipientId}, 1, ${prekey}, 'message', 'peer', '{}', '{}', ${fixture.broadcastId}::uuid,
      ${FINALIZE_NOW.toISOString()}::timestamptz, ${FINALIZE_NOW.addDays(1).toISOString()}::timestamptz,
      ${FINALIZE_NOW.toISOString()}::timestamptz)
  `;
  await transaction`
    INSERT INTO murmur.e2ee_broadcast_deliveries(tenant_id, broadcast_id, recipient_id,
      recipient_generation, claim_id, envelope_json, sender_chain_json, ciphertext_bytes, accepted_at)
    VALUES (${fixture.tenantId.value}::uuid, ${fixture.broadcastId}::uuid, ${delivery.recipientId}, 1,
      ${delivery.claimId}::uuid, ${transaction.json(delivery.envelope)},
      ${transaction.json(invalidChain ? {} : finalizeSenderChain(fixture.prefix))},
      ${paddedLength + 16}, ${FINALIZE_NOW.toISOString()}::timestamptz)
  `;
}

async function deleteTenant(admin: Sql, tenantId: TenantId): Promise<void> {
  await admin`DELETE FROM murmur.e2ee_messages WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.e2ee_broadcasts WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.e2ee_key_bundles WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.agents WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenants WHERE tenant_id = ${tenantId.value}::uuid`;
}

export async function withPostgresFinalizeFixture(
  count: number,
  paddedLength: number,
  invalidLastChain: boolean,
  run: (fixture: PostgresFinalizeFixture) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("Disposable PostgreSQL URLs are required");
  const budget: MaterializationByteBudget = new MaterializationByteBudget(8 * 1024 * 1024);
  const queries: string[] = [];
  const scratchSamples: number[] = [];
  const admin: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 2,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
    debug: (_connection: number, query: string): void => {
      queries.push(query);
      scratchSamples.push(budget.reservedBytes);
    },
  });
  const tenantId: TenantId = TenantId.generate();
  const prefix: string = `finalize-${tenantId.value.slice(0, 8)}-`;
  const fixture: PostgresFinalizeFixture = {
    admin,
    app,
    authorization: { ...FINALIZE_AUTHORIZATION, boundSenderId: `${prefix}sender` },
    broadcastId: randomUUID(),
    budget,
    prefix,
    queries,
    scratchSamples,
    tenantId,
  };
  try {
    await admin.begin(async (transaction: TransactionSql): Promise<void> => {
      await transaction`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        VALUES (${tenantId.value}::uuid, ${`finalize-${tenantId.value}`}, 'Broadcast memory fixture')`;
      await transaction`UPDATE murmur.tenant_e2ee_state SET state = 'provisioning',
        plaintext_writes_blocked = true WHERE tenant_id = ${tenantId.value}::uuid`;
      await transaction`UPDATE murmur.tenant_e2ee_state SET state = 'enforced',
        plaintext_writes_blocked = true, trust_policy_version = 1 WHERE tenant_id = ${tenantId.value}::uuid`;
      await transaction`INSERT INTO murmur.tenant_message_sequences(tenant_id, last_sequence)
        VALUES (${tenantId.value}::uuid, 0)`;
      await transaction`INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
        VALUES (${tenantId.value}::uuid, ${`${prefix}sender`}, 'Sender', '{}',
          ${FINALIZE_NOW.toISOString()}::timestamptz, ${FINALIZE_NOW.toISOString()}::timestamptz)`;
      await transaction`INSERT INTO murmur.e2ee_broadcasts(tenant_id, broadcast_id, sender_id,
        sender_generation, sender_authority, thread_id, request_json, recipient_count, state, created_at, expires_at)
        VALUES (${tenantId.value}::uuid, ${fixture.broadcastId}::uuid, ${`${prefix}sender`}, 1, 'peer',
          'finalize-memory', '{}', ${count}, 'pending', ${FINALIZE_NOW.toISOString()}::timestamptz,
          ${FINALIZE_NOW.addDays(1).toISOString()}::timestamptz)`;
      // Seed one DTO at a time so the performance fixture itself never retains 100 large payloads.
      for (let index: number = 0; index < count; index += 1) {
        await seedDelivery(
          transaction,
          fixture,
          index,
          paddedLength,
          invalidLastChain && index === count - 1,
        );
      }
      await transaction`UPDATE murmur.tenant_e2ee_usage SET claim_count = ${count},
        pending_broadcast_count = 1, pending_delivery_count = ${count},
        pending_ciphertext_bytes = ${count * (paddedLength + 16)} WHERE tenant_id = ${tenantId.value}::uuid`;
    });
    await run(fixture);
  } finally {
    try {
      await deleteTenant(admin, tenantId);
    } finally {
      await Promise.all([app.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
    }
  }
}
