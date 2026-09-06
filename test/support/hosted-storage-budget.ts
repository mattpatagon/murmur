import { expect } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { POSTGRES_RUNTIME_CONNECTION } from "../../src/postgres-runtime.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import { adminDatabaseUrl, databaseUrl, testTlsConfiguration } from "./hosted-mcp-harness.js";

const IntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .transform((value: string | number | bigint): number => Number(value))
  .pipe(z.number().int().nonnegative().safe());

const BudgetSchema: z.ZodObject<{
  accounted_bytes: z.ZodType<number>;
  audit_bytes: z.ZodType<number>;
  audit_rows: z.ZodType<number>;
  feedback_bytes: z.ZodType<number>;
  feedback_rows: z.ZodType<number>;
  max_audit_bytes: z.ZodType<number>;
  max_audit_rows: z.ZodType<number>;
  max_bytes: z.ZodType<number>;
  max_feedback_bytes: z.ZodType<number>;
  max_feedback_rows: z.ZodType<number>;
  max_rows: z.ZodType<number>;
  retained_rows: z.ZodType<number>;
}> = z.strictObject({
  accounted_bytes: IntegerSchema,
  audit_bytes: IntegerSchema,
  audit_rows: IntegerSchema,
  feedback_bytes: IntegerSchema,
  feedback_rows: IntegerSchema,
  max_audit_bytes: IntegerSchema,
  max_audit_rows: IntegerSchema,
  max_bytes: IntegerSchema,
  max_feedback_bytes: IntegerSchema,
  max_feedback_rows: IntegerSchema,
  max_rows: IntegerSchema,
  retained_rows: IntegerSchema,
});

export type HostedStorageBudget = z.infer<typeof BudgetSchema>;
export type StorageBudgetFixture = {
  readonly admin: Sql;
  readonly app: Sql;
  readonly firstTenant: string;
  readonly secondTenant: string;
  readonly actorToken: string;
  readonly operatorHash: Buffer;
};

export const storageBudgetTestsEnabled: boolean = process.env["MURMUR_TEST_STORAGE_BUDGET"] === "1";
if (storageBudgetTestsEnabled && (adminDatabaseUrl === undefined || databaseUrl === undefined)) {
  throw new Error("Requested storage budget gate requires both disposable PostgreSQL URLs");
}

export async function readStorageBudget(
  database: Sql | TransactionSql,
): Promise<HostedStorageBudget> {
  const raw: unknown = await database`
    SELECT retained_rows, accounted_bytes, feedback_rows, feedback_bytes, audit_rows, audit_bytes,
      max_rows, max_bytes, max_feedback_rows, max_feedback_bytes, max_audit_rows, max_audit_bytes
    FROM murmur.hosted_storage_budget WHERE singleton_id = 1
  `;
  const rows: HostedStorageBudget[] = z.array(BudgetSchema).parse(raw);
  const row: HostedStorageBudget | undefined = rows[0];
  if (row === undefined || rows.length !== 1) throw new Error("Storage budget row is missing");
  return row;
}

export async function restoreStorageLimits(
  database: Sql,
  budget: HostedStorageBudget,
): Promise<void> {
  await database`
    UPDATE murmur.hosted_storage_budget SET
      max_rows = ${budget.max_rows}, max_bytes = ${budget.max_bytes},
      max_feedback_rows = ${budget.max_feedback_rows}, max_feedback_bytes = ${budget.max_feedback_bytes},
      max_audit_rows = ${budget.max_audit_rows}, max_audit_bytes = ${budget.max_audit_bytes}
    WHERE singleton_id = 1
  `;
}

export async function assertStorageBudgetReconciles(database: Sql): Promise<void> {
  const before: HostedStorageBudget = await readStorageBudget(database);
  await database`SELECT murmur.reconcile_hosted_storage_budget()`;
  expect(await readStorageBudget(database)).toEqual(before);
}

export async function insertStorageMessage(
  database: Sql,
  tenant: string,
  content: string = "Retained storage budget regression",
  messageId: string = randomUUID(),
): Promise<string> {
  await database.begin(async (transaction: TransactionSql): Promise<void> => {
    await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${tenant}, true)`;
    await transaction`
      INSERT INTO murmur.messages(
        tenant_id, message_id, thread_id, sender_id, recipient_id, content, created_at, expires_at
      ) VALUES (
        ${tenant}::uuid, ${messageId}::uuid, 'storage-budget', 'sender', 'recipient', ${content},
        pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '30 days'
      )
    `;
  });
  return messageId;
}

async function seedStorageTenant(database: Sql, tenantId: string): Promise<void> {
  await database`
    INSERT INTO murmur.tenants(tenant_id, slug, display_name)
    VALUES (${tenantId}::uuid, ${`budget-${tenantId}`}, 'Storage budget regression')
  `;
  await database`
    INSERT INTO murmur.tenant_message_sequences(tenant_id, last_sequence)
    VALUES (${tenantId}::uuid, 0)
  `;
  await database`
    INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
    SELECT ${tenantId}::uuid, identity, identity, '{}'::jsonb,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
    FROM pg_catalog.unnest(ARRAY['sender', 'recipient']::text[]) AS identity
  `;
}

async function deleteStorageTenant(database: Sql, tenant: string): Promise<void> {
  await database`DELETE FROM murmur.e2ee_messages WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.e2ee_broadcasts WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.e2ee_key_bundles WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.feedback_submissions WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.notices WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.messages WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.broadcasts WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.orchestrator_policies WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.agents WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.access_tokens WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.tenant_e2ee_state WHERE tenant_id = ${tenant}::uuid`;
  await database`DELETE FROM murmur.admin_audit WHERE target_id = ${tenant}`;
  await database`DELETE FROM murmur.tenants WHERE tenant_id = ${tenant}::uuid`;
}

export async function withStorageBudgetFixture(
  run: (fixture: StorageBudgetFixture) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined) {
    throw new Error("Hosted storage budget tests require disposable PostgreSQL URLs");
  }
  const admin: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 2,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 4,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const firstTenant: string = randomUUID();
  const secondTenant: string = randomUUID();
  const actorToken: string = randomUUID();
  const operatorToken: string = randomUUID();
  const operatorHash: Buffer = randomBytes(32);
  let original: HostedStorageBudget | null = null;
  try {
    original = await readStorageBudget(admin);
    await seedStorageTenant(admin, firstTenant);
    await seedStorageTenant(admin, secondTenant);
    await admin`
      INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name)
      VALUES (${actorToken}::uuid, ${firstTenant}::uuid, ${`Budget${actorToken.slice(0, 8)}`},
        ${randomBytes(32)}, 'tenant_admin', 'Storage budget administrator')
    `;
    await admin`
      INSERT INTO murmur.operator_tokens(token_id, key_id, secret_hash, name)
      VALUES (${operatorToken}::uuid, ${`BudgetOp${operatorToken.slice(0, 8)}`},
        ${operatorHash}, 'Storage budget operator')
    `;
    await run({ actorToken, admin, app, firstTenant, operatorHash, secondTenant });
  } finally {
    try {
      if (original !== null) {
        await restoreStorageLimits(admin, original);
        await deleteStorageTenant(admin, firstTenant);
        await deleteStorageTenant(admin, secondTenant);
        await admin`DELETE FROM murmur.operator_tokens WHERE token_id = ${operatorToken}::uuid`;
        await assertStorageBudgetReconciles(admin);
      }
    } finally {
      await Promise.all([app.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
    }
  }
}
