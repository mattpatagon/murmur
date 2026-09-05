import { expect, test } from "bun:test";
import process from "node:process";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { UnknownAgentError } from "../src/domain/errors.js";
import { AgentGeneration } from "../src/domain/lifecycle-values.js";
import type { Message } from "../src/domain/models.js";
import { AgentId, DisplayName, Instant, Sequence } from "../src/domain/value-objects.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import { MAX_INBOX_PAGE_BYTES } from "../src/storage/inbox-page-budget.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { getPostgresEncryptedMessages } from "../src/storage/postgres-e2ee-inbox.js";
import { getPostgresMessages } from "../src/storage/postgres-inbox-store.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import {
  createPostgresE2eeTestTenant,
  type PostgresE2eeTestTenant,
} from "./support/e2ee-postgres-tenant.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";
import {
  PAGE_ERROR,
  pageQuery,
  registerPageAgents,
  seedEncryptedPage,
  seedPlaintextPage,
} from "./support/inbox-page-fixture.js";
import { MutableClock } from "./support/store-fixture.js";

const applicationDatabaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];

async function closePageFixtures(
  admin: Sql,
  tenants: readonly PostgresE2eeTestTenant[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const tenant of [...tenants].reverse()) {
    try {
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        const id: string = tenant.tenantId.value;
        await transaction`DELETE FROM murmur.e2ee_messages WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.e2ee_claims WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.e2ee_broadcasts WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.e2ee_key_bundles WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.messages WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.broadcasts WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.agent_sessions WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.access_tokens WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.tenant_e2ee_state WHERE tenant_id = ${id}::uuid`;
        await transaction`DELETE FROM murmur.admin_audit WHERE target_id = ${id}`;
        await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${id}::uuid`;
      });
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      await tenant.close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Inbox page fixture cleanup failed");
}

test.skipIf(applicationDatabaseUrl === undefined || adminDatabaseUrl === undefined)(
  "PostgreSQL enforces the same plaintext and encrypted page budgets without losing filtered messages",
  async (): Promise<void> => {
    if (applicationDatabaseUrl === undefined || adminDatabaseUrl === undefined) {
      throw new Error("Disposable PostgreSQL credentials are required");
    }
    const now: Date = new Date();
    const admin: Sql = postgres(adminDatabaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
    });
    let transferredPlaintextBytes: number = 0;
    let transferredEnvelopeBytes: number = 0;
    const observed: Sql = postgres(applicationDatabaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(applicationDatabaseUrl, testTlsConfiguration),
      transform: {
        row: (row: Record<string, unknown>): Record<string, unknown> => {
          const content: unknown = row["content"];
          const envelope: unknown = row["envelope_json"];
          if (typeof content === "string") transferredPlaintextBytes += Buffer.byteLength(content);
          if (typeof envelope === "string") transferredEnvelopeBytes += Buffer.byteLength(envelope);
          return row;
        },
      },
    });
    const tenants: PostgresE2eeTestTenant[] = [];
    let rootStore: PostgresMessageStore | null = null;
    try {
      const tenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
        adminDatabaseUrl,
        testTlsConfiguration,
      );
      tenants.push(tenant);
      const otherTenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
        adminDatabaseUrl,
        testTlsConfiguration,
      );
      tenants.push(otherTenant);
      rootStore = await PostgresMessageStore.connect(
        applicationDatabaseUrl,
        testTlsConfiguration,
        new MutableClock(Instant.parse(now.toISOString())),
      );
      await tenant.beginProvisioning();
      const store: MessageStore = rootStore.scope(tenant.tenantId);
      const otherStore: MessageStore = rootStore.scope(otherTenant.tenantId);
      await registerPageAgents(store);
      // The fresh hosted gate still has global compatibility keys before bootstrap finalization.
      const otherReader: AgentId = AgentId.parse(`page-reader-${otherTenant.tenantId.value}`);
      await otherStore.registerAgent({
        agentId: otherReader,
        displayName: DisplayName.parse("Other tenant reader"),
        metadata: {},
      });
      await seedPlaintextPage(
        store,
        Array.from({ length: 7 }, (): string => "\u0001".repeat(100_000)),
      );
      const queryTime: Instant = Instant.parse(now.toISOString());
      await expect(
        getPostgresMessages(observed, tenant.tenantId, pageQuery(500), queryTime),
      ).rejects.toThrow(PAGE_ERROR);
      expect(transferredPlaintextBytes).toBe(0);
      expect(
        await getPostgresMessages(observed, tenant.tenantId, pageQuery(1), queryTime),
      ).toHaveLength(1);
      expect(transferredPlaintextBytes).toBe(100_000);
      const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
      const scope: MaterializationScope = new MaterializationScope(budget);
      const finishHandler: () => void = scope.startHandler();
      try {
        await withMaterializationScope(scope, async (): Promise<void> => {
          await expect(store.getMessages(pageQuery(500))).rejects.toThrow(PAGE_ERROR);
          expect(budget.reservedBytes).toBe(0);
          await expect(otherStore.getMessages(pageQuery(500))).rejects.toBeInstanceOf(
            UnknownAgentError,
          );
          expect(budget.reservedBytes).toBe(0);
          expect(await otherStore.getMessages({ ...pageQuery(500), agentId: otherReader })).toEqual(
            [],
          );
          expect(budget.reservedBytes).toBe(0);
          expect(
            await store.getMessages({ ...pageQuery(500), agentId: AgentId.parse("charlie") }),
          ).toEqual([]);
          expect(
            await store.getMessages({ ...pageQuery(500), generation: AgentGeneration.parse(2) }),
          ).toEqual([]);
          const single: readonly Message[] = await store.getMessages(pageQuery(1));
          expect(single).toHaveLength(1);
          expect(budget.reservedBytes).toBe(13 * 100_000 + 16_384);
        });
        finishHandler();
        expect(budget.reservedBytes).toBeGreaterThan(0);
        scope.finishResponse();
        expect(budget.reservedBytes).toBe(0);
      } finally {
        finishHandler();
        scope.finishResponse();
      }
      const first: Message | undefined = (await store.getMessages(pageQuery(1)))[0];
      if (first === undefined) throw new Error("First page is missing");
      expect(
        await store.getMessages({ ...pageQuery(500), afterSequence: first.sequence }),
      ).toHaveLength(6);
      expect(await store.getMessages({ ...pageQuery(500), threadId: first.threadId })).toHaveLength(
        1,
      );
      await store.markMessagesRead({
        agentId: AgentId.parse("bob"),
        generation: null,
        messageIds: [first.messageId],
        sessionKey: null,
      });
      expect(await store.getMessages({ ...pageQuery(500), unreadOnly: true })).toHaveLength(6);
      const encrypted: E2eeMessageStore = rootStore.scopeE2ee(tenant.tenantId);
      await seedEncryptedPage(encrypted, tenant.tenantId.value, 4, now, async (): Promise<void> => {
        const unread: readonly Message[] = await store.getMessages({
          ...pageQuery(500),
          unreadOnly: true,
        });
        await store.markMessagesRead({
          agentId: AgentId.parse("bob"),
          generation: null,
          messageIds: unread.map((message: Message): Message["messageId"] => message.messageId),
          sessionKey: null,
        });
        await store.closeAgent({
          agentId: AgentId.parse("charlie"),
          closeReason: "completed",
          expectedGeneration: AgentGeneration.parse(1),
        });
        await tenant.enforce();
      });
      const input: {
        readonly after_sequence: number;
        readonly agent_id: string;
        readonly limit: number;
        readonly unread_only: boolean;
      } = { after_sequence: 0, agent_id: "bob", limit: 500, unread_only: false };
      await expect(
        getPostgresEncryptedMessages(observed, tenant.tenantId, input, queryTime),
      ).rejects.toThrow(PAGE_ERROR);
      expect(transferredEnvelopeBytes).toBe(0);
      expect(
        (
          await getPostgresEncryptedMessages(
            observed,
            tenant.tenantId,
            { ...input, limit: 1 },
            queryTime,
          )
        ).messages,
      ).toHaveLength(1);
      expect(transferredEnvelopeBytes).toBeGreaterThan(699_072);
      await expect(encrypted.getEncryptedMessages(input)).rejects.toThrow(PAGE_ERROR);
      const inbox: Awaited<ReturnType<E2eeMessageStore["getEncryptedMessages"]>> =
        await encrypted.getEncryptedMessages({ ...input, limit: 1 });
      expect(inbox.messages).toHaveLength(1);
      const paired: Awaited<ReturnType<MessageStore["getMessagesWithVersion"]>> =
        await store.getMessagesWithVersion(pageQuery(1));
      expect(paired.messages).toHaveLength(1);
      expect(paired.inboxVersion.value).toBe(inbox.inbox_version);
      expect(paired.inboxVersion.value).toBeGreaterThan(first.sequence.value);
      const encryptedFirst: (typeof inbox.messages)[number] | undefined = inbox.messages[0];
      if (encryptedFirst === undefined) throw new Error("Encrypted first page is missing");
      expect(encryptedFirst.envelope.ciphertext.length).toBe(699_072);
      const remainder: Awaited<ReturnType<E2eeMessageStore["getEncryptedMessages"]>> =
        await encrypted.getEncryptedMessages({
          ...input,
          after_sequence: encryptedFirst.tenant_sequence,
        });
      expect(remainder.messages).toHaveLength(3);
      expect(
        remainder.messages.every(
          (message: (typeof remainder.messages)[number]): boolean =>
            message.tenant_sequence > encryptedFirst.tenant_sequence,
        ),
      ).toBe(true);
      expect(
        await otherStore.getMessages({
          ...pageQuery(500),
          agentId: otherReader,
          afterSequence: Sequence.zero(),
        }),
      ).toEqual([]);
    } finally {
      try {
        if (rootStore !== null) await rootStore.close();
      } finally {
        try {
          await observed.end({ timeout: 1 });
        } finally {
          try {
            await closePageFixtures(admin, tenants);
          } finally {
            await admin.end({ timeout: 1 });
          }
        }
      }
    }
  },
  30_000,
);
