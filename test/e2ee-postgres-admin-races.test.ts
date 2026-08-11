import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import process from "node:process";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import {
  type CanaryE2eeIdentity,
  createCanaryE2eeIdentity,
} from "../scripts/lib/e2ee-canary-crypto.js";
import { AgentId, DisplayName, Instant, type TenantId } from "../src/domain/value-objects.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { E2eeWriteAuthorization } from "../src/storage/e2ee-message-store.js";
import { claimPostgresEncryptionPrekeyInTransaction } from "../src/storage/postgres-e2ee-keys.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { setPostgresTenantContext } from "../src/storage/postgres-message-transactions.js";
import { type DeferredSignal, deferredSignal } from "./support/cloud-mcp-harness.js";
import { testE2eeBundle } from "./support/e2ee-hosted-crypto.js";
import {
  createPostgresE2eeTestTenant,
  type PostgresE2eeTestTenant,
} from "./support/e2ee-postgres-tenant.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";

const databaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;
const CountSchema: z.ZodType<[{ readonly count: number }]> = z.tuple([
  z.strictObject({ count: z.coerce.number().int().nonnegative() }),
]);

function adminConnection(url: string, applicationName: string): Sql {
  return postgres(url, {
    connect_timeout: 10,
    connection: { application_name: applicationName },
    max: 1,
    ssl: postgresSslOptions(url, testTlsConfiguration),
  });
}

async function waitForBlockedQuery(
  observer: Sql,
  applicationName: string,
  queryFragment: string,
): Promise<void> {
  let attempt: number = 0;
  while (attempt < 200) {
    const raw: unknown = await observer`
      SELECT pg_catalog.count(*)::int AS count
      FROM pg_catalog.pg_stat_activity
      WHERE application_name = ${applicationName}
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${queryFragment}%`}
    `;
    if (CountSchema.parse(raw)[0].count > 0) return;
    await Bun.sleep(10);
    attempt += 1;
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query '${queryFragment}'`);
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

async function expectSqlState(action: () => Promise<void>, expectedCode: string): Promise<void> {
  try {
    await action();
    throw new Error(`Expected PostgreSQL SQLSTATE ${expectedCode}`);
  } catch (error: unknown) {
    expect(postgresErrorCode(error)).toBe(expectedCode);
  }
}

async function registerEncryptedAgent(
  store: PostgresMessageStore,
  tenantId: TenantId,
  agentId: string,
  repository: string,
  identity: CanaryE2eeIdentity,
): Promise<void> {
  await store.scope(tenantId).registerAgent({
    agentId: AgentId.parse(agentId),
    displayName: DisplayName.parse(agentId),
    metadata: { machine: `${agentId}-machine`, repository },
  });
  await store.scopeE2ee(tenantId).publishAgentKeyBundle({
    agent_id: agentId,
    bundle: testE2eeBundle(identity),
  });
}

test.skipIf(!postgresConfigured)(
  "identity reset preserves usage committed while it waits for the usage row",
  async (): Promise<void> => {
    const configuredDatabaseUrl: string | undefined = databaseUrl;
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    if (configuredDatabaseUrl === undefined || configuredAdminDatabaseUrl === undefined) {
      throw new Error("Hosted database URLs are required");
    }
    const tenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
      configuredAdminDatabaseUrl,
      testTlsConfiguration,
    );
    const store: PostgresMessageStore = await PostgresMessageStore.connect(
      configuredDatabaseUrl,
      testTlsConfiguration,
    );
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 10);
    const targetId: string = `reset-target-${unique}`;
    const senderId: string = `reset-sender-${unique}`;
    const recipientId: string = `reset-recipient-${unique}`;
    const repository: string = `e2ee-test/reset-${unique}`;
    const claimApplication: string = `reset-claim-${unique}`;
    const claimDatabase: Sql = adminConnection(configuredAdminDatabaseUrl, claimApplication);
    const observer: Sql = adminConnection(configuredAdminDatabaseUrl, `reset-observer-${unique}`);
    const claimPrepared: DeferredSignal = deferredSignal();
    const releaseClaim: DeferredSignal = deferredSignal();
    let claimTask: Promise<unknown> | null = null;
    let resetTask: Promise<void> | null = null;
    try {
      await tenant.beginProvisioning();
      const now: Date = new Date();
      const target: CanaryE2eeIdentity = await createCanaryE2eeIdentity(targetId, now);
      await registerEncryptedAgent(store, tenant.tenantId, targetId, repository, target);
      await registerEncryptedAgent(
        store,
        tenant.tenantId,
        senderId,
        repository,
        await createCanaryE2eeIdentity(senderId, now),
      );
      await registerEncryptedAgent(
        store,
        tenant.tenantId,
        recipientId,
        repository,
        await createCanaryE2eeIdentity(recipientId, now),
      );
      await tenant.enforce();
      const authorization: E2eeWriteAuthorization = {
        boundSenderId: null,
        orchestrationScope: null,
        provenance: {
          message_kind: "message",
          orchestrator_policy_id: null,
          sender_authority: "peer",
        },
      };
      claimTask = claimDatabase.begin(async (transaction: TransactionSql): Promise<unknown> => {
        await setPostgresTenantContext(transaction, tenant.tenantId);
        const claim: unknown = await claimPostgresEncryptionPrekeyInTransaction(
          claimDatabase,
          transaction,
          tenant.tenantId,
          {
            context: { branch: "feature/e2ee-reset", client: "codex", repository },
            recipient_id: recipientId,
            sender_id: senderId,
          },
          authorization,
          Instant.parse(new Date().toISOString()),
          null,
        );
        claimPrepared.resolve();
        await releaseClaim.promise;
        return claim;
      });
      await claimPrepared.promise;
      resetTask = tenant.resetIdentity(targetId, target.agentCertificate.rootKeyId);
      await waitForBlockedQuery(observer, tenant.applicationName, "tenant_reset_e2ee_identity");
      releaseClaim.resolve();
      await claimTask;
      await resetTask;
      const raw: unknown = await observer`
        SELECT usage.claim_count::int AS claim_count,
          usage.public_prekey_count::int AS public_prekey_count,
          (
            SELECT pg_catalog.count(*)::int FROM murmur.e2ee_claims AS claim
            WHERE claim.tenant_id = usage.tenant_id AND claim.consumed_at IS NULL
          ) AS actual_claim_count,
          (
            SELECT pg_catalog.count(*)::int FROM murmur.e2ee_prekeys AS prekey
            WHERE prekey.tenant_id = usage.tenant_id
              AND prekey.retired_at IS NULL AND prekey.claimed_at IS NULL
              AND prekey.expires_at > pg_catalog.statement_timestamp()
          ) AS actual_public_prekey_count
        FROM murmur.tenant_e2ee_usage AS usage
        WHERE usage.tenant_id = ${tenant.tenantId.value}::uuid
      `;
      const rows: [
        {
          readonly actual_claim_count: number;
          readonly actual_public_prekey_count: number;
          readonly claim_count: number;
          readonly public_prekey_count: number;
        },
      ] = z
        .tuple([
          z.strictObject({
            actual_claim_count: z.coerce.number().int().nonnegative(),
            actual_public_prekey_count: z.coerce.number().int().nonnegative(),
            claim_count: z.coerce.number().int().nonnegative(),
            public_prekey_count: z.coerce.number().int().nonnegative(),
          }),
        ])
        .parse(raw);
      expect(rows[0].claim_count).toBe(1);
      expect(rows[0].claim_count).toBe(rows[0].actual_claim_count);
      expect(rows[0].public_prekey_count).toBe(rows[0].actual_public_prekey_count);
    } finally {
      releaseClaim.resolve();
      const pending: Promise<unknown>[] = [];
      if (claimTask !== null) pending.push(claimTask);
      if (resetTask !== null) pending.push(resetTask);
      await Promise.allSettled(pending);
      await Promise.allSettled([
        claimDatabase.end({ timeout: 1 }),
        observer.end({ timeout: 1 }),
        store.close(),
        tenant.close(),
      ]);
    }
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "E2E transition admission holds the administrator credential through commit",
  async (): Promise<void> => {
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    if (configuredAdminDatabaseUrl === undefined)
      throw new Error("Hosted database URL is required");
    const tenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
      configuredAdminDatabaseUrl,
      testTlsConfiguration,
    );
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 10);
    const locker: Sql = adminConnection(configuredAdminDatabaseUrl, `transition-locker-${unique}`);
    const mutator: Sql = adminConnection(
      configuredAdminDatabaseUrl,
      `transition-mutator-${unique}`,
    );
    const observer: Sql = adminConnection(
      configuredAdminDatabaseUrl,
      `transition-observer-${unique}`,
    );
    const stateLocked: DeferredSignal = deferredSignal();
    const releaseState: DeferredSignal = deferredSignal();
    let lockerTask: Promise<void> | null = null;
    let transitionTask: Promise<void> | null = null;
    try {
      lockerTask = locker.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`
          SELECT 1 FROM murmur.tenant_e2ee_state
          WHERE tenant_id = ${tenant.tenantId.value}::uuid FOR UPDATE
        `;
        stateLocked.resolve();
        await releaseState.promise;
      });
      await stateLocked.promise;
      transitionTask = tenant.beginProvisioning();
      await waitForBlockedQuery(observer, tenant.applicationName, "tenant_transition_e2ee");
      await expectSqlState(async (): Promise<void> => {
        await mutator.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SET LOCAL lock_timeout = '150ms'`;
          await transaction`
              UPDATE murmur.access_tokens SET revoked_at = pg_catalog.statement_timestamp()
              WHERE tenant_id = ${tenant.tenantId.value}::uuid
                AND token_id = ${tenant.actorTokenId}::uuid
            `;
        });
      }, "55P03");
      releaseState.resolve();
      await transitionTask;
      await mutator`
        UPDATE murmur.access_tokens SET revoked_at = pg_catalog.statement_timestamp()
        WHERE tenant_id = ${tenant.tenantId.value}::uuid
          AND token_id = ${tenant.actorTokenId}::uuid
      `;
      await expect(tenant.beginProvisioning()).rejects.toThrow(
        "tenant administrator credential rejected",
      );
    } finally {
      releaseState.resolve();
      const pending: Promise<unknown>[] = [];
      if (lockerTask !== null) pending.push(lockerTask);
      if (transitionTask !== null) pending.push(transitionTask);
      await Promise.allSettled(pending);
      await Promise.allSettled([
        locker.end({ timeout: 1 }),
        mutator.end({ timeout: 1 }),
        observer.end({ timeout: 1 }),
        tenant.close(),
      ]);
    }
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "identity-reset admission holds tenant status through commit",
  async (): Promise<void> => {
    const configuredDatabaseUrl: string | undefined = databaseUrl;
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    if (configuredDatabaseUrl === undefined || configuredAdminDatabaseUrl === undefined) {
      throw new Error("Hosted database URLs are required");
    }
    const tenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
      configuredAdminDatabaseUrl,
      testTlsConfiguration,
    );
    const store: PostgresMessageStore = await PostgresMessageStore.connect(
      configuredDatabaseUrl,
      testTlsConfiguration,
    );
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 10);
    const targetId: string = `suspend-target-${unique}`;
    const repository: string = `e2ee-test/suspend-${unique}`;
    const locker: Sql = adminConnection(configuredAdminDatabaseUrl, `reset-locker-${unique}`);
    const mutator: Sql = adminConnection(configuredAdminDatabaseUrl, `reset-mutator-${unique}`);
    const observer: Sql = adminConnection(configuredAdminDatabaseUrl, `reset-observer-${unique}`);
    const bundleLocked: DeferredSignal = deferredSignal();
    const releaseBundle: DeferredSignal = deferredSignal();
    let lockerTask: Promise<void> | null = null;
    let resetTask: Promise<void> | null = null;
    try {
      await tenant.beginProvisioning();
      const target: CanaryE2eeIdentity = await createCanaryE2eeIdentity(targetId, new Date());
      await registerEncryptedAgent(store, tenant.tenantId, targetId, repository, target);
      lockerTask = locker.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`
          SELECT 1 FROM murmur.e2ee_key_bundles
          WHERE tenant_id = ${tenant.tenantId.value}::uuid AND agent_id = ${targetId}
          FOR UPDATE
        `;
        bundleLocked.resolve();
        await releaseBundle.promise;
      });
      await bundleLocked.promise;
      resetTask = tenant.resetIdentity(targetId, target.agentCertificate.rootKeyId);
      await waitForBlockedQuery(observer, tenant.applicationName, "tenant_reset_e2ee_identity");
      await expectSqlState(async (): Promise<void> => {
        await mutator.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`SET LOCAL lock_timeout = '150ms'`;
          await transaction`
              UPDATE murmur.tenants SET status = 'suspended',
                suspended_at = pg_catalog.statement_timestamp()
              WHERE tenant_id = ${tenant.tenantId.value}::uuid
            `;
        });
      }, "55P03");
      releaseBundle.resolve();
      await resetTask;
      await mutator`
        UPDATE murmur.tenants SET status = 'suspended',
          suspended_at = pg_catalog.statement_timestamp()
        WHERE tenant_id = ${tenant.tenantId.value}::uuid
      `;
      await expect(
        tenant.resetIdentity(targetId, target.agentCertificate.rootKeyId),
      ).rejects.toThrow("tenant administrator credential rejected");
    } finally {
      releaseBundle.resolve();
      const pending: Promise<unknown>[] = [];
      if (lockerTask !== null) pending.push(lockerTask);
      if (resetTask !== null) pending.push(resetTask);
      await Promise.allSettled(pending);
      await Promise.allSettled([
        locker.end({ timeout: 1 }),
        mutator.end({ timeout: 1 }),
        observer.end({ timeout: 1 }),
        store.close(),
        tenant.close(),
      ]);
    }
  },
  20_000,
);
