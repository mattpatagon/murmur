import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { type AuthRowV2, AuthRowV2Schema } from "../src/hosted/control-plane-rows.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";
import { storageBudgetTestsEnabled } from "./support/hosted-storage-budget.js";

const FIXTURE_ACCOUNTS: number = 2_048;
const configured: boolean = storageBudgetTestsEnabled;

type AuthFixture = {
  readonly transaction: TransactionSql;
  readonly prefix: string;
  readonly tenantId: string;
  readonly tokenId: string;
  readonly hash: Buffer;
};

class RollbackFixture extends Error {}

async function withAuthFixture(run: (fixture: AuthFixture) => Promise<void>): Promise<void> {
  if (adminDatabaseUrl === undefined) throw new Error("Disposable PostgreSQL URL is required");
  const database: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  try {
    await database.begin(async (transaction: TransactionSql): Promise<void> => {
      const prefix: string = `auth-plan-${randomUUID().replaceAll("-", "")}-`;
      const tenantId: string = randomUUID();
      const tokenId: string = randomUUID();
      const hash: Buffer = randomBytes(32);
      await transaction`
        INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        VALUES (${tenantId}::uuid, ${`${prefix}target`}, 'Authentication plan fixture')
      `;
      await transaction`
        INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name, last_used_at)
        VALUES (${tokenId}::uuid, ${tenantId}::uuid, ${tokenId.replaceAll("-", "")}, ${hash},
          'agent', 'Authentication plan fixture', pg_catalog.statement_timestamp())
      `;
      await run({ transaction, prefix, tenantId, tokenId, hash });
      // Roll back all generated rows and lifecycle/accounting changes, including failed assertions.
      throw new RollbackFixture();
    });
  } catch (error: unknown) {
    if (!(error instanceof RollbackFixture)) throw error;
  } finally {
    await database.end({ timeout: 2 });
  }
}

async function authentication(transaction: TransactionSql, hash: Buffer): Promise<AuthRowV2[]> {
  const raw: unknown = await transaction`
    SELECT principal_kind, token_id::text AS token_id, key_id, tenant_id::text AS tenant_id,
      token_role, personal_id::text AS personal_id, repository_name, orchestrator_agent_id
    FROM murmur.authenticate_principal_v2(${hash})
  `;
  return z.array(AuthRowV2Schema).max(1).parse(raw);
}

async function scannedTokenRows(transaction: TransactionSql): Promise<number> {
  const raw: unknown = await transaction`
    SELECT seq_tup_read::text AS rows FROM pg_catalog.pg_stat_xact_user_tables
    WHERE schemaname = 'murmur' AND relname = 'access_tokens'
  `;
  return z
    .tuple([z.strictObject({ rows: z.coerce.number().int().nonnegative().safe() })])
    .parse(raw)[0].rows;
}

test.skipIf(!configured)(
  "real hosted authentication avoids scanning the populated credential directory",
  async (): Promise<void> => {
    await withAuthFixture(async (fixture: AuthFixture): Promise<void> => {
      const transaction: TransactionSql = fixture.transaction;
      await transaction`
        INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        SELECT pg_catalog.gen_random_uuid(), ${fixture.prefix}::text || item::text,
          'Authentication cardinality fixture'
        FROM pg_catalog.generate_series(1, ${FIXTURE_ACCOUNTS - 1}) AS item
      `;
      await transaction`
        INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name, last_used_at)
        SELECT pg_catalog.gen_random_uuid(), tenant_id, replace(tenant_id::text, '-', ''),
          decode(md5(tenant_id::text) || md5(tenant_id::text), 'hex'), 'agent',
          'Authentication cardinality fixture', pg_catalog.statement_timestamp()
        FROM murmur.tenants WHERE slug LIKE ${`${fixture.prefix}%`} AND tenant_id <> ${fixture.tenantId}::uuid
      `;
      await transaction`ANALYZE murmur.access_tokens, murmur.tenants`;
      const planRows: unknown = await transaction`
        EXPLAIN (FORMAT JSON)
        SELECT authenticated.principal_kind, authenticated.token_id, token.personal_id
        FROM murmur.authenticate_principal(${fixture.hash}) AS authenticated
        LEFT JOIN murmur.access_tokens AS token
          ON authenticated.principal_kind = 'tenant'
          AND token.tenant_id = authenticated.tenant_id AND token.token_id = authenticated.token_id
      `;
      const plan: string = JSON.stringify(planRows);
      await transaction`SET LOCAL ROLE murmur_app`;
      expect<unknown>(await transaction`SELECT current_user AS role`).toEqual([
        { role: "murmur_app" },
      ]);
      const before: number = await scannedTokenRows(transaction);
      for (let attempt: number = 0; attempt < 3; attempt += 1) {
        const principals: AuthRowV2[] = await authentication(transaction, fixture.hash);
        expect(principals).toHaveLength(1);
        expect(principals[0]).toMatchObject({
          principal_kind: "tenant",
          tenant_id: fixture.tenantId,
          token_id: fixture.tokenId,
        });
      }
      const scanned: number = (await scannedTokenRows(transaction)) - before;
      // This measures the actual security-definer wrapper, not only a duplicated EXPLAIN query.
      expect(scanned).toBe(0);
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
      expect(plan).toContain('"Node Type":"Index Scan"');
    });
  },
  30_000,
);

test.skipIf(!configured)(
  "single-principal planning retains authoritative tenant, operator and revocation checks",
  async (): Promise<void> => {
    await withAuthFixture(async (fixture: AuthFixture): Promise<void> => {
      const transaction: TransactionSql = fixture.transaction;
      const operatorId: string = randomUUID();
      const operatorHash: Buffer = randomBytes(32);
      await transaction`
        INSERT INTO murmur.operator_tokens(token_id, key_id, secret_hash, name)
        VALUES (${operatorId}::uuid, ${operatorId.replaceAll("-", "")}, ${operatorHash}, 'Auth plan operator')
      `;
      await transaction`SET LOCAL ROLE murmur_app`;
      expect<unknown>(await transaction`SELECT current_user AS role`).toEqual([
        { role: "murmur_app" },
      ]);
      expect(await authentication(transaction, randomBytes(32))).toEqual([]);
      expect((await authentication(transaction, fixture.hash))[0]).toMatchObject({
        personal_id: fixture.tokenId,
        principal_kind: "tenant",
        tenant_id: fixture.tenantId,
        token_role: "agent",
      });
      expect((await authentication(transaction, operatorHash))[0]).toMatchObject({
        personal_id: null,
        principal_kind: "operator",
        tenant_id: null,
        token_id: operatorId,
        token_role: null,
      });
      await transaction`RESET ROLE`;
      await transaction`
        UPDATE murmur.tenants SET status = 'suspended', suspended_at = pg_catalog.statement_timestamp()
        WHERE tenant_id = ${fixture.tenantId}::uuid
      `;
      await transaction`SET LOCAL ROLE murmur_app`;
      expect(await authentication(transaction, fixture.hash)).toEqual([]);
      expect(await authentication(transaction, operatorHash)).toHaveLength(1);
      await transaction`RESET ROLE`;
      await transaction`
        UPDATE murmur.tenants SET status = 'active', suspended_at = NULL WHERE tenant_id = ${fixture.tenantId}::uuid
      `;
      await transaction`
        UPDATE murmur.access_tokens SET revoked_at = pg_catalog.statement_timestamp()
        WHERE token_id = ${fixture.tokenId}::uuid
      `;
      await transaction`
        UPDATE murmur.operator_tokens SET revoked_at = pg_catalog.statement_timestamp()
        WHERE token_id = ${operatorId}::uuid
      `;
      await transaction`SET LOCAL ROLE murmur_app`;
      expect(await authentication(transaction, fixture.hash)).toEqual([]);
      expect(await authentication(transaction, operatorHash)).toEqual([]);
    });
  },
  30_000,
);
