import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import process from "node:process";

import postgres, { type Sql } from "postgres";

import { AgentId, type Clock, DisplayName, Instant } from "../src/domain/value-objects.js";
import type {
  AcknowledgeEncryptedMessagesOutput,
  EncryptedMessageReadReceiptDto,
} from "../src/e2ee/wire-tools.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { runConcurrentEncryptedAcknowledgements } from "./support/e2ee-postgres-acknowledgement-race.js";
import {
  createPostgresE2eeTestTenant,
  type PostgresE2eeTestTenant,
} from "./support/e2ee-postgres-tenant.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";

const databaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

class FixedClock implements Clock {
  private readonly value: Instant;

  public constructor(value: Instant) {
    this.value = value;
  }

  public now(): Instant {
    return this.value;
  }
}

test.skipIf(!postgresConfigured)(
  "overlapping PostgreSQL acknowledgements return the durable ordered receipts",
  async (): Promise<void> => {
    const configuredDatabaseUrl: string | undefined = databaseUrl;
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    if (configuredDatabaseUrl === undefined || configuredAdminDatabaseUrl === undefined) {
      throw new Error("Hosted database URLs are required");
    }
    const firstReadAt: Instant = Instant.parse("2035-04-05T06:07:08.009Z");
    const secondReadAt: Instant = firstReadAt.addMinutes(1);
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 10);
    const senderId: string = `ack-sender-${unique}`;
    const recipientId: string = `ack-recipient-${unique}`;
    const messageIds: readonly string[] = [randomUUID(), randomUUID()].sort().reverse();
    const tenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
      configuredAdminDatabaseUrl,
      testTlsConfiguration,
    );
    const firstStore: PostgresMessageStore = await PostgresMessageStore.connect(
      configuredDatabaseUrl,
      testTlsConfiguration,
      new FixedClock(firstReadAt),
    );
    const secondStore: PostgresMessageStore = await PostgresMessageStore.connect(
      configuredDatabaseUrl,
      testTlsConfiguration,
      new FixedClock(secondReadAt),
    );
    const admin: Sql = postgres(configuredAdminDatabaseUrl, {
      connect_timeout: 10,
      max: 1,
      ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
    });
    try {
      await tenant.beginProvisioning();
      const scoped: MessageStore = firstStore.scope(tenant.tenantId);
      for (const agentId of [senderId, recipientId]) {
        await scoped.registerAgent({
          agentId: AgentId.parse(agentId),
          displayName: DisplayName.parse(agentId),
          metadata: { repository: "test/acknowledgement-race" },
        });
      }
      const createdAt: string = firstReadAt.addMinutes(-1).toISOString();
      const expiresAt: string = firstReadAt.addDays(1).toISOString();
      for (const [index, messageId] of messageIds.entries()) {
        await admin`
          INSERT INTO murmur.e2ee_messages(
            tenant_id, tenant_sequence, message_id, thread_id, sender_id, sender_generation,
            sender_authority, message_kind, recipient_id, recipient_generation, idempotency_key,
            pair_counter, envelope_json, sender_chain_json, ciphertext_bytes, created_at, expires_at
          ) VALUES (
            ${tenant.tenantId.value}::uuid, ${index + 1}, ${messageId}::uuid,
            'acknowledgement-race', ${senderId}, 1, 'peer', 'message', ${recipientId}, 1,
            ${`acknowledgement-race-${index}`}, ${index + 1}, '{}', '{}', 17,
            ${createdAt}::timestamptz, ${expiresAt}::timestamptz
          )
        `;
      }
      const firstEncrypted: E2eeMessageStore = firstStore.scopeE2ee(tenant.tenantId);
      const secondEncrypted: E2eeMessageStore = secondStore.scopeE2ee(tenant.tenantId);
      const concurrent: Awaited<ReturnType<typeof runConcurrentEncryptedAcknowledgements>> =
        await runConcurrentEncryptedAcknowledgements({
          adminDatabaseUrl: configuredAdminDatabaseUrl,
          first: async (): Promise<AcknowledgeEncryptedMessagesOutput> =>
            await firstEncrypted.acknowledgeEncryptedMessages({
              agent_id: recipientId,
              message_ids: [...messageIds],
            }),
          messageIds,
          second: async (): Promise<AcknowledgeEncryptedMessagesOutput> =>
            await secondEncrypted.acknowledgeEncryptedMessages({
              agent_id: recipientId,
              message_ids: [...messageIds],
            }),
          tenantId: tenant.tenantId.value,
        });
      expect(concurrent.first).toEqual({ receipts: concurrent.stored, updated: 2 });
      expect(concurrent.second).toEqual(concurrent.first);
      expect(
        concurrent.stored.map(
          (receipt: EncryptedMessageReadReceiptDto): string => receipt.message_id,
        ),
      ).toEqual([...messageIds].sort());
      const durableTimestamps: Set<string> = new Set(
        concurrent.stored.map((receipt: EncryptedMessageReadReceiptDto): string => receipt.read_at),
      );
      expect(durableTimestamps.size).toBe(1);
      const durableReceipt: (typeof concurrent.stored)[number] | undefined = concurrent.stored[0];
      if (durableReceipt === undefined) throw new Error("Durable acknowledgement is missing");
      expect([firstReadAt.toISOString(), secondReadAt.toISOString()]).toContain(
        durableReceipt.read_at,
      );
    } finally {
      await Promise.allSettled([
        admin.end({ timeout: 5 }),
        secondStore.close(),
        firstStore.close(),
        tenant.close(),
      ]);
    }
  },
  30_000,
);
