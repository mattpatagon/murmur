import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import {
  createSelfServicePostgresTenant,
  TenantRegistrationBusyError,
  TenantRegistrationCapacityError,
  TenantRegistrationRateLimitError,
} from "../src/hosted/self-service-tenant-control-plane.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";

const limitsEnabled: boolean = process.env["MURMUR_TEST_REGISTRATION_LIMITS"] === "1";
const CountRowsSchema: z.ZodArray<z.ZodObject<{ registration_count: z.ZodNumber }>> = z.array(
  z.strictObject({ registration_count: z.number() }),
);

function registrationSecret(): string {
  return randomBytes(32).toString("base64url");
}

async function resetRegistrationState(database: Sql): Promise<void> {
  await database`
    UPDATE murmur.self_service_registration_state
    SET window_started_at = pg_catalog.statement_timestamp(), registration_count = 0
    WHERE singleton_id = 1
  `;
}

async function deleteCapacityTenants(database: Sql, prefix: string): Promise<void> {
  const pattern: string = `${prefix}-%`;
  await database`
    DELETE FROM murmur.tenant_e2ee_usage AS usage
    USING murmur.tenants AS tenant
    WHERE usage.tenant_id = tenant.tenant_id AND tenant.slug LIKE ${pattern}
  `;
  await database`
    DELETE FROM murmur.tenant_e2ee_state AS state
    USING murmur.tenants AS tenant
    WHERE state.tenant_id = tenant.tenant_id AND tenant.slug LIKE ${pattern}
  `;
  await database`
    DELETE FROM murmur.tenant_resource_usage AS usage
    USING murmur.tenants AS tenant
    WHERE usage.tenant_id = tenant.tenant_id AND tenant.slug LIKE ${pattern}
  `;
  await database`
    DELETE FROM murmur.tenant_message_sequences AS sequence
    USING murmur.tenants AS tenant
    WHERE sequence.tenant_id = tenant.tenant_id AND tenant.slug LIKE ${pattern}
  `;
  await database`DELETE FROM murmur.tenants WHERE slug LIKE ${pattern}`;
}

test.skipIf(!limitsEnabled || databaseUrl === undefined || adminDatabaseUrl === undefined)(
  "self-service PostgreSQL limits, replay, and audit remain atomic",
  async (): Promise<void> => {
    const configuredAppUrl: string | undefined = databaseUrl;
    const configuredAdminUrl: string | undefined = adminDatabaseUrl;
    if (configuredAppUrl === undefined || configuredAdminUrl === undefined) {
      throw new Error("Hosted PostgreSQL URLs are required");
    }
    const app: Sql = postgres(configuredAppUrl, {
      max: 2,
      ssl: postgresSslOptions(configuredAppUrl, testTlsConfiguration),
    });
    const admin: Sql = postgres(configuredAdminUrl, {
      max: 2,
      ssl: postgresSslOptions(configuredAdminUrl, testTlsConfiguration),
    });
    const createdTenantIds: string[] = [];
    const capacityPrefixes: string[] = [];
    try {
      await resetRegistrationState(admin);
      await admin`
        UPDATE murmur.self_service_registration_state
        SET registration_count = 60
        WHERE singleton_id = 1
      `;
      const rateSlug: string = `rate-${randomUUID()}`;
      await expect(
        createSelfServicePostgresTenant(app, rateSlug, "Rate limited", registrationSecret()),
      ).rejects.toBeInstanceOf(TenantRegistrationRateLimitError);
      const rateRows: unknown = await admin`
          SELECT pg_catalog.count(*)::integer AS count
          FROM murmur.tenants
          WHERE slug = ${rateSlug}
        `;
      expect(z.array(z.strictObject({ count: z.number() })).parse(rateRows)).toEqual([
        { count: 0 },
      ]);

      await resetRegistrationState(admin);
      const busySlug: string = `busy-${randomUUID()}`;
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`
          SELECT singleton_id
          FROM murmur.self_service_registration_state
          WHERE singleton_id = 1
          FOR UPDATE
        `;
        await expect(
          createSelfServicePostgresTenant(app, busySlug, "Busy", registrationSecret()),
        ).rejects.toBeInstanceOf(TenantRegistrationBusyError);
      });

      const tenantCountRows: Array<{ readonly count: number }> = z
        .array(z.strictObject({ count: z.number() }))
        .parse(await admin`SELECT pg_catalog.count(*)::integer AS count FROM murmur.tenants`);
      const firstCount: { readonly count: number } | undefined = tenantCountRows[0];
      if (firstCount === undefined) throw new Error("Tenant count query returned no row");
      const capacityPrefix: string = `capacity-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      capacityPrefixes.push(capacityPrefix);
      const capacityRows: number = Math.max(0, 100_000 - firstCount.count);
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`ALTER TABLE murmur.tenants DISABLE TRIGGER USER`;
        await transaction`
          INSERT INTO murmur.tenants(tenant_id, slug, display_name)
          SELECT
            (
              pg_catalog.substr(pg_catalog.md5(${capacityPrefix} || series::text), 1, 8) || '-' ||
              pg_catalog.substr(pg_catalog.md5(${capacityPrefix} || series::text), 9, 4) || '-' ||
              pg_catalog.substr(pg_catalog.md5(${capacityPrefix} || series::text), 13, 4) || '-' ||
              pg_catalog.substr(pg_catalog.md5(${capacityPrefix} || series::text), 17, 4) || '-' ||
              pg_catalog.substr(pg_catalog.md5(${capacityPrefix} || series::text), 21, 12)
            )::uuid,
            ${capacityPrefix} || '-' || series::text,
            'Capacity probe'
          FROM pg_catalog.generate_series(1, ${capacityRows}::integer) AS series
        `;
        await transaction`ALTER TABLE murmur.tenants ENABLE TRIGGER USER`;
        await transaction`SELECT murmur.reconcile_hosted_storage_budget()`;
      });
      await resetRegistrationState(admin);
      await expect(
        createSelfServicePostgresTenant(
          app,
          `full-${randomUUID()}`,
          "At capacity",
          registrationSecret(),
        ),
      ).rejects.toBeInstanceOf(TenantRegistrationCapacityError);
      expect(
        CountRowsSchema.parse(
          await admin`
            SELECT registration_count
            FROM murmur.self_service_registration_state
            WHERE singleton_id = 1
          `,
        ),
      ).toEqual([{ registration_count: 0 }]);
      await deleteCapacityTenants(admin, capacityPrefix);
      capacityPrefixes.pop();

      const secret: string = registrationSecret();
      const slug: string = `audit-${randomUUID()}`;
      const first: Awaited<ReturnType<typeof createSelfServicePostgresTenant>> =
        await createSelfServicePostgresTenant(app, slug, "Audited tenant", secret);
      createdTenantIds.push(first.tenant.tenantId.value);
      const countAfterFirst: Array<{ readonly registration_count: number }> = CountRowsSchema.parse(
        await admin`
          SELECT registration_count
          FROM murmur.self_service_registration_state
          WHERE singleton_id = 1
        `,
      );
      const replayed: Awaited<ReturnType<typeof createSelfServicePostgresTenant>> =
        await createSelfServicePostgresTenant(app, slug, "Audited tenant", secret);
      expect(replayed).toEqual(first);
      expect(
        CountRowsSchema.parse(
          await admin`
            SELECT registration_count
            FROM murmur.self_service_registration_state
            WHERE singleton_id = 1
          `,
        ),
      ).toEqual(countAfterFirst);
      const auditRows: unknown = await admin`
        SELECT
          action,
          metadata->>'display_name' AS display_name,
          metadata->>'slug' AS slug,
          metadata = pg_catalog.jsonb_build_object(
            'slug', ${slug}::text, 'display_name', 'Audited tenant'
          ) AS metadata_matches
        FROM murmur.admin_audit
        WHERE target_id = ${first.tenant.tenantId.value}
      `;
      expect(auditRows).toEqual([
        {
          action: "tenant.self_service_create",
          display_name: "Audited tenant",
          metadata_matches: true,
          slug,
        },
      ]);
      expect(JSON.stringify(auditRows)).not.toContain(secret);
      expect(JSON.stringify(auditRows)).not.toContain(first.token.secret);
    } finally {
      await resetRegistrationState(admin);
      for (const capacityPrefix of capacityPrefixes) {
        await deleteCapacityTenants(admin, capacityPrefix);
      }
      for (const tenantId of createdTenantIds) {
        await admin`DELETE FROM murmur.admin_audit WHERE target_id = ${tenantId}`;
        await admin`DELETE FROM murmur.access_tokens WHERE tenant_id = ${tenantId}::uuid`;
        await admin`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${tenantId}::uuid`;
        await admin`DELETE FROM murmur.tenant_e2ee_state WHERE tenant_id = ${tenantId}::uuid`;
        await admin`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenantId}::uuid`;
        await admin`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenantId}::uuid`;
        await admin`DELETE FROM murmur.tenants WHERE tenant_id = ${tenantId}::uuid`;
      }
      await Promise.all([app.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
    }
  },
  120_000,
);
