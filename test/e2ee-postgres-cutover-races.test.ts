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
    const rows: [{ readonly count: number }] = CountSchema.parse(raw);
    if (rows[0].count > 0) return;
    await Bun.sleep(10);
    attempt += 1;
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query '${queryFragment}'`);
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
  "plaintext admission serializes with the hosted E2E cutover",
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
    const senderId: string = `cutover-sender-${unique}`;
    const recipientId: string = `cutover-recipient-${unique}`;
    const repository: string = `e2ee-test/cutover-${unique}`;
    const writer: Sql = adminConnection(configuredAdminDatabaseUrl, `cutover-writer-${unique}`);
    const observer: Sql = adminConnection(configuredAdminDatabaseUrl, `cutover-observer-${unique}`);
    const inserted: DeferredSignal = deferredSignal();
    const releaseWriter: DeferredSignal = deferredSignal();
    let writerTask: Promise<void> | null = null;
    let transitionTask: Promise<void> | null = null;
    try {
      await tenant.beginProvisioning();
      const now: Date = new Date();
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
      writerTask = writer.begin(async (transaction: TransactionSql): Promise<void> => {
        await setPostgresTenantContext(transaction, tenant.tenantId);
        await transaction`
          INSERT INTO murmur.messages(
            tenant_id, message_id, thread_id, sender_id, recipient_id,
            sender_generation, recipient_generation, content, sender_authority, message_kind,
            repository_name, branch_name, client_name, idempotency_key, created_at, expires_at
          ) VALUES (
            ${tenant.tenantId.value}::uuid, ${randomUUID()}::uuid, ${`cutover-${unique}`},
            ${senderId}, ${recipientId}, 1, 1, 'plaintext cutover regression', 'peer', 'message',
            ${repository}, 'feature/e2ee-cutover', 'codex', ${`cutover-${unique}`},
            pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '30 days'
          )
        `;
        inserted.resolve();
        await releaseWriter.promise;
      });
      await inserted.promise;
      transitionTask = tenant.blockPlaintextWrites();
      await waitForBlockedQuery(observer, tenant.applicationName, "tenant_transition_e2ee");
      releaseWriter.resolve();
      await writerTask;
      await transitionTask;
      const rawCount: unknown = await observer`
        SELECT pg_catalog.count(*)::int AS count FROM murmur.messages
        WHERE tenant_id = ${tenant.tenantId.value}::uuid AND content = 'plaintext cutover regression'
      `;
      expect(CountSchema.parse(rawCount)[0].count).toBe(1);
      await expect(tenant.finishEnforcement()).rejects.toThrow(
        "tenant E2E enforcement prerequisites are incomplete",
      );
    } finally {
      releaseWriter.resolve();
      const pending: Promise<unknown>[] = [];
      if (writerTask !== null) pending.push(writerTask);
      if (transitionTask !== null) pending.push(transitionTask);
      await Promise.allSettled(pending);
      await Promise.allSettled([
        writer.end({ timeout: 1 }),
        observer.end({ timeout: 1 }),
        store.close(),
        tenant.close(),
      ]);
    }
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "rollback cannot pass an in-flight encryption claim",
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
    const senderId: string = `rollback-sender-${unique}`;
    const recipientId: string = `rollback-recipient-${unique}`;
    const repository: string = `e2ee-test/rollback-${unique}`;
    const claimApplication: string = `rollback-claim-${unique}`;
    const claimDatabase: Sql = adminConnection(configuredAdminDatabaseUrl, claimApplication);
    const locker: Sql = adminConnection(configuredAdminDatabaseUrl, `rollback-locker-${unique}`);
    const observer: Sql = adminConnection(
      configuredAdminDatabaseUrl,
      `rollback-observer-${unique}`,
    );
    const prekeyLocked: DeferredSignal = deferredSignal();
    const releasePrekey: DeferredSignal = deferredSignal();
    let lockerTask: Promise<void> | null = null;
    let claimTask: Promise<unknown> | null = null;
    let rollbackTask: Promise<void> | null = null;
    try {
      await tenant.beginProvisioning();
      const now: Date = new Date();
      const sender: CanaryE2eeIdentity = await createCanaryE2eeIdentity(senderId, now);
      const recipient: CanaryE2eeIdentity = await createCanaryE2eeIdentity(recipientId, now);
      await registerEncryptedAgent(store, tenant.tenantId, senderId, repository, sender);
      await registerEncryptedAgent(store, tenant.tenantId, recipientId, repository, recipient);
      await tenant.enforce();
      const recipientBundle: ReturnType<typeof testE2eeBundle> = testE2eeBundle(recipient);
      const selectedPrekey: (typeof recipientBundle.one_time_prekeys)[number] | undefined =
        recipientBundle.one_time_prekeys[0];
      if (selectedPrekey === undefined)
        throw new Error("E2E test recipient has no one-time prekey");
      lockerTask = locker.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`
          SELECT 1 FROM murmur.e2ee_prekeys
          WHERE tenant_id = ${tenant.tenantId.value}::uuid
            AND prekey_id = ${selectedPrekey.prekey_id}
          FOR UPDATE
        `;
        prekeyLocked.resolve();
        await releasePrekey.promise;
      });
      await prekeyLocked.promise;
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
        return await claimPostgresEncryptionPrekeyInTransaction(
          claimDatabase,
          transaction,
          tenant.tenantId,
          {
            context: { branch: "feature/e2ee-rollback", client: "codex", repository },
            recipient_id: recipientId,
            sender_id: senderId,
          },
          authorization,
          Instant.parse(new Date().toISOString()),
          null,
        );
      });
      await waitForBlockedQuery(observer, claimApplication, "e2ee_prekeys");
      rollbackTask = tenant.rollback();
      await waitForBlockedQuery(observer, tenant.applicationName, "tenant_transition_e2ee");
      releasePrekey.resolve();
      await claimTask;
      await expect(rollbackTask).rejects.toThrow(
        "tenant E2E rollback is unavailable while ciphertext is retained",
      );
      const raw: unknown = await observer`
        SELECT state, usage.claim_count::int AS claim_count
        FROM murmur.tenant_e2ee_state AS state
        JOIN murmur.tenant_e2ee_usage AS usage USING (tenant_id)
        WHERE state.tenant_id = ${tenant.tenantId.value}::uuid
      `;
      const rows: [{ readonly claim_count: number; readonly state: string }] = z
        .tuple([
          z.strictObject({ claim_count: z.coerce.number().int().positive(), state: z.string() }),
        ])
        .parse(raw);
      expect(rows[0]).toEqual({ claim_count: 1, state: "enforced" });
    } finally {
      releasePrekey.resolve();
      const pending: Promise<unknown>[] = [];
      if (lockerTask !== null) pending.push(lockerTask);
      if (claimTask !== null) pending.push(claimTask);
      if (rollbackTask !== null) pending.push(rollbackTask);
      await Promise.allSettled(pending);
      await Promise.allSettled([
        claimDatabase.end({ timeout: 1 }),
        locker.end({ timeout: 1 }),
        observer.end({ timeout: 1 }),
        store.close(),
        tenant.close(),
      ]);
    }
  },
  20_000,
);
