import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import type { SendMessageCommand } from "../src/domain/models.js";
import { AgentId, DisplayName, TenantId } from "../src/domain/value-objects.js";
import { PostgresHostedControlPlane } from "../src/hosted/control-plane.js";
import { generateTokenSecret, type HostedTokenSecret } from "../src/hosted/token-secret.js";
import {
  POSTGRES_RUNTIME_CONNECTION,
  POSTGRES_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS,
  POSTGRES_RUNTIME_LOCK_TIMEOUT_MS,
  POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS,
} from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { MessageStore } from "../src/storage/message-store.js";
import {
  POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED,
  PostgresMessageStore,
} from "../src/storage/postgres-message-store.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";
import { baseMessageCommand } from "./support/store-fixture.js";

const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

test.skipIf(databaseUrl === undefined)(
  "PostgreSQL installs all runtime execution bounds when the connection opens",
  async (): Promise<void> => {
    if (databaseUrl === undefined) throw new Error("Hosted PostgreSQL URL is required");
    const database: Sql = postgres(databaseUrl, {
      connect_timeout: 10,
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
    });
    try {
      const raw: unknown = await database`
        SELECT
          (EXTRACT(EPOCH FROM pg_catalog.current_setting('statement_timeout')::interval) * 1000)::int
            AS statement_timeout_ms,
          (EXTRACT(EPOCH FROM pg_catalog.current_setting('lock_timeout')::interval) * 1000)::int
            AS lock_timeout_ms,
          (EXTRACT(EPOCH FROM pg_catalog.current_setting('idle_in_transaction_session_timeout')::interval) * 1000)::int
            AS idle_transaction_timeout_ms
      `;
      const rows: readonly {
        readonly statement_timeout_ms: number;
        readonly lock_timeout_ms: number;
        readonly idle_transaction_timeout_ms: number;
      }[] = z
        .array(
          z.strictObject({
            statement_timeout_ms: z.number().int(),
            lock_timeout_ms: z.number().int(),
            idle_transaction_timeout_ms: z.number().int(),
          }),
        )
        .parse(raw);
      expect(rows).toEqual([
        {
          statement_timeout_ms: POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS,
          lock_timeout_ms: POSTGRES_RUNTIME_LOCK_TIMEOUT_MS,
          idle_transaction_timeout_ms: POSTGRES_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS,
        },
      ]);
    } finally {
      await database.end({ timeout: 1 });
    }
  },
  10_000,
);

type RuntimeFixture = {
  readonly admin: Sql;
  readonly appUrl: string;
  readonly tenantId: TenantId;
  readonly token: HostedTokenSecret;
};

async function withRuntimeFixture(run: (fixture: RuntimeFixture) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined) {
    throw new Error("Hosted PostgreSQL URLs are required");
  }
  const admin: Sql = postgres(adminDatabaseUrl, {
    connect_timeout: 10,
    connection: {
      idle_in_transaction_session_timeout: 10_000,
      lock_timeout: 1_000,
      statement_timeout: 5_000,
    },
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const tenantId: TenantId = TenantId.generate();
  const token: HostedTokenSecret = generateTokenSecret("mur");
  try {
    await admin`
      INSERT INTO murmur.tenants(tenant_id, slug, display_name)
      VALUES (${tenantId.value}::uuid, ${`runtime-${tenantId.value}`}, 'Runtime bounds test')
    `;
    await admin`
      INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name)
      VALUES (${randomUUID()}::uuid, ${tenantId.value}::uuid, ${token.keyId}, ${token.hash},
        'agent', 'Runtime bounds credential')
    `;
    await run({ admin, appUrl: databaseUrl, tenantId, token });
  } finally {
    try {
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`DELETE FROM murmur.messages WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.access_tokens WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_e2ee_state WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenantId.value}::uuid`;
        await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${tenantId.value}::uuid`;
      });
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
}

async function expectRuntimeLockTimeout(
  admin: Sql,
  acquireLock: (transaction: TransactionSql) => Promise<void>,
  run: () => Promise<unknown>,
): Promise<void> {
  let failure: unknown = null;
  let operation: Promise<void> = Promise.resolve();
  let completedWhileLocked: boolean = false;
  await admin.begin(async (transaction: TransactionSql): Promise<void> => {
    await acquireLock(transaction);
    operation = run().then(
      (): void => undefined,
      (error: unknown): void => {
        failure = error;
      },
    );
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline: Promise<boolean> = new Promise((resolve: (value: boolean) => void): void => {
      timeout = setTimeout((): void => resolve(false), 4_000);
    });
    try {
      completedWhileLocked = await Promise.race([operation.then((): boolean => true), deadline]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  });
  // Release the blocker even on the pre-fix path before waiting for the operation to settle.
  await operation;
  expect(completedWhileLocked).toBe(true);
  expect(failure).toHaveProperty("code", "55P03");
}

test.skipIf(!postgresConfigured)(
  "runtime message pool times out tenant lock contention and recovers without a partial write",
  async (): Promise<void> => {
    await withRuntimeFixture(async (fixture: RuntimeFixture): Promise<void> => {
      const store: PostgresMessageStore = await PostgresMessageStore.connect(
        fixture.appUrl,
        testTlsConfiguration,
      );
      try {
        const scoped: MessageStore = store.scope(fixture.tenantId);
        for (const id of ["alice", "bob"]) {
          await scoped.registerAgent({
            agentId: AgentId.parse(id),
            displayName: DisplayName.parse(id),
            metadata: {},
          });
        }
        const command: SendMessageCommand = baseMessageCommand();
        await expectRuntimeLockTimeout(
          fixture.admin,
          async (transaction: TransactionSql): Promise<void> => {
            await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
              ${`${fixture.tenantId.value}:alice`}, ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
            ))
          `;
          },
          async (): Promise<unknown> => await scoped.sendMessage(command),
        );
        const sent: Awaited<ReturnType<MessageStore["sendMessage"]>> =
          await scoped.sendMessage(command);
        expect(sent.duplicate).toBe(false);
        expect(sent.message.sequence.value).toBe(1);
      } finally {
        await store.close();
      }
    });
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "runtime control-plane pool times out credential row contention and recovers",
  async (): Promise<void> => {
    await withRuntimeFixture(async (fixture: RuntimeFixture): Promise<void> => {
      const controlPlane: PostgresHostedControlPlane = await PostgresHostedControlPlane.connect(
        fixture.appUrl,
        testTlsConfiguration,
      );
      try {
        await expectRuntimeLockTimeout(
          fixture.admin,
          async (transaction: TransactionSql): Promise<void> => {
            await transaction`
            SELECT token_id FROM murmur.access_tokens
            WHERE tenant_id = ${fixture.tenantId.value}::uuid AND key_id = ${fixture.token.keyId}
            FOR UPDATE
          `;
          },
          async (): Promise<unknown> => await controlPlane.authenticate(fixture.token.secret),
        );
        expect(await controlPlane.authenticate(fixture.token.secret)).toMatchObject({
          kind: "tenant",
          tenantId: fixture.tenantId,
        });
      } finally {
        await controlPlane.close();
      }
    });
  },
  20_000,
);
