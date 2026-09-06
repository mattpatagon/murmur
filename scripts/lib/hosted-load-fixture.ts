import { randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { generateTokenSecret, type HostedTokenSecret } from "../../src/hosted/token-secret.js";
import { type HostedLoadConfig, requireLoad } from "./hosted-load-config.js";

export type LoadTenant = {
  readonly id: string;
  readonly index: number;
  readonly token: HostedTokenSecret;
  readonly tokenId: string;
};

export type LoadDatabaseStats = {
  readonly tenants: number;
  readonly tokens: number;
  readonly agents: number;
  readonly messages: number;
  readonly unreadMessages: number;
  readonly databaseBytes: number;
  readonly schemaBytes: number;
};

const DatabaseStatsSchema: z.ZodType<LoadDatabaseStats> = z.strictObject({
  tenants: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  unreadMessages: z.number().int().nonnegative(),
  databaseBytes: z.coerce.number().int().nonnegative().safe(),
  schemaBytes: z.coerce.number().int().nonnegative().safe(),
});

type TenantSeedRow = { tenant_id: string; slug: string; display_name: string };
type TokenSeedRow = {
  token_id: string;
  tenant_id: string;
  key_id: string;
  secret_hash: Buffer;
  token_role: string;
  name: string;
  personal_id: string;
};

export class HostedLoadFixture {
  public readonly tenants: readonly LoadTenant[];
  private readonly prefix: string = `load-${randomUUID().replaceAll("-", "").slice(0, 12)}-`;
  private readonly admin: Sql;
  private readonly runtime: Sql;
  private seeded: boolean = false;

  public constructor(private readonly config: HostedLoadConfig) {
    const options: postgres.Options<Record<string, postgres.PostgresType>> = {
      connect_timeout: 5,
      max: 1,
      ssl: false,
      connection: { statement_timeout: 15_000, lock_timeout: 2_000 },
    };
    this.admin = postgres(config.adminUrl, options);
    this.runtime = postgres(config.runtimeUrl, options);
    this.tenants = Array.from(
      { length: config.tenantCount },
      (_unused: unknown, index: number): LoadTenant => ({
        id: randomUUID(),
        index,
        token: generateTokenSecret("mur"),
        tokenId: randomUUID(),
      }),
    );
  }

  public async verify(): Promise<void> {
    const rows: unknown = await this.runtime`
      SELECT current_database() AS name, current_user AS role,
        role.rolsuper AS superuser, role.rolbypassrls AS bypass,
        (SELECT count(*)::int FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'murmur' AND relation.relowner = role.oid) AS owned,
        (SELECT bool_and(relation.relrowsecurity AND relation.relforcerowsecurity)
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'murmur'
            AND relation.relname IN ('agents', 'messages', 'access_tokens', 'agent_sessions')) AS rls,
        murmur.operator_has_active_token() AS operator
      FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
    `;
    const row:
      | {
          name: string;
          role: string;
          superuser: boolean;
          bypass: boolean;
          owned: number;
          rls: boolean;
          operator: boolean;
        }
      | undefined = z
      .array(
        z.strictObject({
          name: z.string(),
          role: z.string(),
          superuser: z.boolean(),
          bypass: z.boolean(),
          owned: z.number(),
          rls: z.boolean(),
          operator: z.boolean(),
        }),
      )
      .parse(rows)[0];
    requireLoad(
      row !== undefined &&
        row.name === this.config.databaseName &&
        row.role === "murmur_app" &&
        !row.superuser &&
        !row.bypass &&
        row.owned === 0 &&
        row.rls &&
        row.operator,
      "Disposable database runtime role, forced RLS, or strict bootstrap contract is invalid",
    );
    const locks: unknown = await this.admin`
      SELECT pg_catalog.pg_try_advisory_lock(1297437266, 25000) AS acquired,
        current_database() AS name,
        (SELECT tenant_contract_version FROM murmur.platform_state WHERE singleton_id = 1) AS version
    `;
    const lock: { acquired: boolean; name: string; version: number } | undefined = z
      .array(
        z.strictObject({
          acquired: z.boolean(),
          name: z.string(),
          version: z.number(),
        }),
      )
      .parse(locks)[0];
    requireLoad(
      lock !== undefined &&
        lock.acquired &&
        lock.name === this.config.databaseName &&
        lock.version === 2,
      "Load database is already in use or its tenant contract is not ready",
    );
  }

  public async seed(signal: AbortSignal): Promise<void> {
    this.seeded = true;
    for (let offset: number = 0; offset < this.tenants.length; offset += 500) {
      signal.throwIfAborted();
      const batch: readonly LoadTenant[] = this.tenants.slice(offset, offset + 500);
      await this.admin.begin(async (transaction: TransactionSql): Promise<void> => {
        const tenants: TenantSeedRow[] = batch.map(
          (tenant: LoadTenant): TenantSeedRow => ({
            tenant_id: tenant.id,
            slug: `${this.prefix}${tenant.index}`,
            display_name: "Disposable load fixture",
          }),
        );
        const tokens: TokenSeedRow[] = batch.map(
          (tenant: LoadTenant): TokenSeedRow => ({
            token_id: tenant.tokenId,
            tenant_id: tenant.id,
            key_id: tenant.token.keyId,
            secret_hash: tenant.token.hash,
            token_role: "agent",
            name: "Disposable load fixture",
            personal_id: tenant.tokenId,
          }),
        );
        await transaction`INSERT INTO murmur.tenants ${transaction(tenants, "tenant_id", "slug", "display_name")}`;
        await transaction`INSERT INTO murmur.access_tokens ${transaction(tokens, "token_id", "tenant_id", "key_id", "secret_hash", "token_role", "name", "personal_id")}`;
      });
    }
  }

  public async stats(): Promise<LoadDatabaseStats> {
    const rows: unknown = await this.admin`
      WITH fixture AS (SELECT tenant_id FROM murmur.tenants WHERE slug LIKE ${`${this.prefix}%`})
      SELECT
        (SELECT count(*)::int FROM fixture) AS tenants,
        (SELECT count(*)::int FROM murmur.access_tokens WHERE tenant_id IN (SELECT tenant_id FROM fixture)) AS tokens,
        (SELECT count(*)::int FROM murmur.agents WHERE tenant_id IN (SELECT tenant_id FROM fixture)) AS agents,
        (SELECT count(*)::int FROM murmur.messages WHERE tenant_id IN (SELECT tenant_id FROM fixture)) AS messages,
        (SELECT count(*)::int FROM murmur.messages WHERE tenant_id IN (SELECT tenant_id FROM fixture) AND read_at IS NULL) AS "unreadMessages",
        pg_catalog.pg_database_size(current_database())::text AS "databaseBytes",
        (SELECT coalesce(sum(pg_catalog.pg_total_relation_size(relation.oid)), 0)::text
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'murmur' AND relation.relkind IN ('r', 'm')) AS "schemaBytes"
    `;
    const row: LoadDatabaseStats | undefined = z.array(DatabaseStatsSchema).parse(rows)[0];
    requireLoad(row !== undefined, "Load database metrics are missing");
    return row;
  }

  public async verifyTenantRows(tenant: LoadTenant): Promise<void> {
    const rows: unknown = await this.runtime.begin(
      async (transaction: TransactionSql): Promise<unknown> => {
        await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${tenant.id}, true)`;
        return await transaction`SELECT count(*)::int AS count,
        coalesce(bool_and(tenant_id = ${tenant.id}::uuid), true) AS isolated
        FROM murmur.messages`;
      },
    );
    const row: { count: number; isolated: boolean } | undefined = z
      .array(
        z.strictObject({
          count: z.number().int().nonnegative(),
          isolated: z.boolean(),
        }),
      )
      .parse(rows)[0];
    requireLoad(
      row !== undefined && row.count > 0 && row.isolated,
      "Direct runtime tenant isolation failed",
    );
    const unscoped: unknown = await this
      .runtime`SELECT count(*)::int AS count FROM murmur.messages`;
    const visible: { count: number } | undefined = z
      .array(z.strictObject({ count: z.number() }))
      .parse(unscoped)[0];
    requireLoad(
      visible !== undefined && visible.count === 0,
      "Runtime tenant context escaped its transaction",
    );
  }

  public async close(): Promise<void> {
    try {
      if (this.seeded) {
        const cleanupDeadline: number = Date.now() + 60_000;
        for (let offset: number = 0; offset < this.tenants.length; offset += 500) {
          requireLoad(Date.now() < cleanupDeadline, "Load fixture cleanup exceeded its deadline");
          const ids: string[] = this.tenants
            .slice(offset, offset + 500)
            .map((tenant: LoadTenant): string => tenant.id);
          await this.admin.begin(async (transaction: TransactionSql): Promise<void> => {
            for (const table of [
              "messages",
              "agent_sessions",
              "agents",
              "access_tokens",
              "tenant_message_sequences",
              "tenant_e2ee_usage",
              "tenant_e2ee_state",
              "tenant_resource_usage",
              "tenants",
            ]) {
              await transaction`DELETE FROM ${transaction(`murmur.${table}`)} WHERE tenant_id = ANY(${transaction.array(ids)}::uuid[])`;
            }
          });
        }
        const remaining: LoadDatabaseStats = await this.stats();
        requireLoad(
          remaining.tenants === 0 && remaining.messages === 0 && remaining.tokens === 0,
          "Disposable load fixture cleanup was incomplete",
        );
      }
    } finally {
      const results: PromiseSettledResult<void>[] = await Promise.allSettled([
        this.runtime.end({ timeout: 2 }),
        this.admin.end({ timeout: 2 }),
      ]);
      requireLoad(
        results.every(
          (result: PromiseSettledResult<void>): boolean => result.status === "fulfilled",
        ),
        "Load database connections failed to close",
      );
    }
  }
}
