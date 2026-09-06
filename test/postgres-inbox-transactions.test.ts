import { expect, test } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { UnknownAgentError } from "../src/domain/errors.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { GetMessagesQuery, Message, SendMessageResult } from "../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  IdempotencyKey,
  type Instant,
  Sequence,
  SystemClock,
  TenantId,
} from "../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { InboxReadResult, MessageStore } from "../src/storage/message-store.js";
import { PostgresInboxDispatcher } from "../src/storage/postgres-inbox-dispatcher.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";
import { baseMessageCommand, MutableClock } from "./support/store-fixture.js";

type Fixture = {
  readonly admin: Sql;
  readonly clock: MutableClock;
  readonly now: Instant;
  readonly other: MessageStore;
  readonly otherReader: AgentId;
  readonly reader: AgentId;
  readonly sender: AgentId;
  readonly statements: string[];
  readonly store: PostgresMessageStore;
  readonly tenant: TenantId;
};
const SESSION: SessionKey = SessionKey.parse("reader-pane");
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("PostgreSQL URLs are required");
  const tenant: TenantId = TenantId.generate();
  const otherTenant: TenantId = TenantId.generate();
  const reader: AgentId = AgentId.parse(`reader:${tenant.value}`);
  const sender: AgentId = AgentId.parse(`sender:${tenant.value}`);
  const otherReader: AgentId = AgentId.parse(`reader:${otherTenant.value}`);
  const now: Instant = new SystemClock().now();
  const clock: MutableClock = new MutableClock(now);
  const statements: string[] = [];
  const admin: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    debug: (_connection: number, query: string): void => {
      statements.push(query);
    },
    max: 1,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  // Use the runtime adapter with an instrumented least-privilege pool, without a notification listener.
  const candidate: unknown = Reflect.construct(PostgresMessageStore, [
    app,
    clock,
    tenant,
    {
      closed: false,
      closePromise: null,
      dispatcher: new PostgresInboxDispatcher({
        readVersion: async (): Promise<Sequence> => Sequence.zero(),
        reportError: (): void => {},
      }),
      listener: null,
    },
    true,
  ]);
  if (!(candidate instanceof PostgresMessageStore))
    throw new Error("Invalid PostgreSQL inbox fixture");
  const store: PostgresMessageStore = candidate;
  try {
    expect(
      Array.from(
        await app`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`,
      ),
    ).toEqual([{ name: "murmur_app", rolbypassrls: false, rolsuper: false }]);
    for (const id of [tenant, otherTenant]) {
      await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        VALUES (${id.value}::uuid, ${`inbox-transactions-${id.value}`}, 'Inbox transaction fixture')`;
    }
    const other: MessageStore = store.scope(otherTenant);
    for (const agentId of [reader, sender]) {
      await store.registerAgent({
        agentId,
        displayName: DisplayName.parse("Inbox actor"),
        metadata: {},
      });
    }
    await store.registerAgent({
      agentId: reader,
      displayName: DisplayName.parse("Inbox reader"),
      metadata: {},
      sessionKey: SESSION,
    });
    await other.registerAgent({
      agentId: otherReader,
      displayName: DisplayName.parse("Other reader"),
      metadata: {},
    });
    await run({ admin, clock, now, other, otherReader, reader, sender, statements, store, tenant });
  } finally {
    try {
      await store.close();
    } finally {
      try {
        for (const id of [tenant, otherTenant]) {
          await admin.begin(async (transaction: TransactionSql): Promise<void> => {
            await transaction`DELETE FROM murmur.messages WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${id.value}::uuid`;
          });
        }
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }
}

function query(agentId: AgentId): GetMessagesQuery {
  return {
    afterSequence: Sequence.zero(),
    agentId,
    limit: 10,
    sessionKey: null,
    threadId: null,
    unreadOnly: false,
  };
}

function expectInboxTransactions(statements: readonly string[], expectedStatements: number): void {
  expect(
    statements.filter((statement: string): boolean => statement.trim() === "begin"),
  ).toHaveLength(2);
  expect(
    statements.filter((statement: string): boolean => statement.trim() === "commit"),
  ).toHaveLength(2);
  expect(statements).toHaveLength(expectedStatements);
  expect(
    statements.filter((statement: string): boolean => statement.includes("set_config")),
  ).toHaveLength(2);
  expect(
    statements.filter((statement: string): boolean => statement.includes("AS candidates")),
  ).toHaveLength(1);
  expect(statements[1]).toContain("set_config");
  expect(statements[2]).toContain("AS candidates");
  expect(statements.slice(3, 5).map((statement: string): string => statement.trim())).toEqual([
    "commit",
    "begin",
  ]);
  expect(
    statements.filter((statement: string): boolean =>
      statement.includes("session.live_session_count"),
    ),
  ).toHaveLength(1);
  expect(
    statements.some((statement: string): boolean =>
      statement.includes("SELECT authority, generation"),
    ),
  ).toBe(false);
}

test.skipIf(!postgresConfigured)(
  "PostgreSQL paired inbox reads include fresh expiry preflight without losing filters, sessions or tenant isolation",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const first: SendMessageResult = await fixture.store.sendMessage({
        ...baseMessageCommand(),
        recipientId: fixture.reader,
        senderId: fixture.sender,
      });
      const second: SendMessageResult = await fixture.store.sendMessage({
        ...baseMessageCommand(),
        recipientId: fixture.reader,
        senderId: fixture.sender,
        idempotencyKey: IdempotencyKey.parse("paired-second-message"),
      });
      fixture.statements.length = 0;
      const page: InboxReadResult = await fixture.store.getMessagesWithVersion({
        ...query(fixture.reader),
        limit: 1,
        threadId: first.message.threadId,
      });
      expectInboxTransactions(fixture.statements, 9);
      expect(page.messages.map((message: Message): string => message.messageId.value)).toEqual([
        first.message.messageId.value,
      ]);
      expect(page.inboxVersion.value).toBe(second.message.sequence.value);
      await fixture.store.markMessagesRead({
        agentId: fixture.reader,
        messageIds: [first.message.messageId],
      });
      const filtered: InboxReadResult = await fixture.store.getMessagesWithVersion({
        ...query(fixture.reader),
        threadId: first.message.threadId,
        unreadOnly: true,
      });
      expect(filtered.messages).toEqual([]);
      expect(filtered.inboxVersion.value).toBe(second.message.sequence.value);
      fixture.clock.set(fixture.now.addMinutes(5));
      await fixture.store.getMessagesWithVersion({ ...query(fixture.reader), sessionKey: SESSION });
      await expectLease(fixture, SESSION, fixture.clock.now());
      await expectLease(fixture, SessionKey.default(), fixture.now);
      await expect(
        fixture.other.getMessagesWithVersion(query(fixture.reader)),
      ).rejects.toBeInstanceOf(UnknownAgentError);
      const other: InboxReadResult = await fixture.other.getMessagesWithVersion(
        query(fixture.otherReader),
      );
      expect(other.messages).toEqual([]);
      expect(other.inboxVersion.value).toBe(0);
      await fixture.store.closeAgent({
        agentId: fixture.reader,
        closeReason: "completed",
        expectedGeneration: AgentGeneration.parse(1),
      });
      await fixture.store.registerAgent({
        agentId: fixture.reader,
        displayName: DisplayName.parse("Reopened paired reader"),
        metadata: {},
      });
      const current: InboxReadResult = await fixture.store.getMessagesWithVersion(
        query(fixture.reader),
      );
      expect(current.messages).toEqual([]);
      expect(current.inboxVersion.value).toBe(0);
      const historical: InboxReadResult = await fixture.store.getMessagesWithVersion({
        ...query(fixture.reader),
        generation: AgentGeneration.parse(1),
      });
      expect(historical.messages).toHaveLength(2);
      expect(historical.inboxVersion.value).toBe(second.message.sequence.value);
    });
  },
  20_000,
);

async function expectLease(fixture: Fixture, session: SessionKey, renewed: Instant): Promise<void> {
  expect(
    Array.from(
      await fixture.admin`
    SELECT to_char(last_renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS renewed,
      to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires
    FROM murmur.agent_sessions
    WHERE tenant_id = ${fixture.tenant.value}::uuid AND agent_id = ${fixture.reader.value}
      AND generation = 1 AND session_key = ${session.value} AND ended_at IS NULL
  `,
    ),
  ).toEqual([{ expires: renewed.addMinutes(60).toISOString(), renewed: renewed.toISOString() }]);
}

async function verifySessionsAndIsolation(fixture: Fixture): Promise<void> {
  fixture.clock.set(fixture.now.addMinutes(5));
  await fixture.store.getMessages(query(fixture.reader));
  await expectLease(fixture, SessionKey.default(), fixture.now);
  await expectLease(fixture, SESSION, fixture.now);
  await fixture.store.getMessages({ ...query(fixture.reader), sessionKey: SESSION });
  await expectLease(fixture, SESSION, fixture.clock.now());
  fixture.clock.set(fixture.now.addMinutes(10));
  expect(
    await fixture.store.markMessagesRead({
      agentId: fixture.reader,
      messageIds: [],
      sessionKey: SESSION,
    }),
  ).toEqual({ readAt: fixture.clock.now(), updated: 0 });
  await expectLease(fixture, SESSION, fixture.clock.now());
  await expectLease(fixture, SessionKey.default(), fixture.now);
  const missingSession: SessionKey = SessionKey.parse("unknown-observer");
  await fixture.store.getMessages({ ...query(fixture.reader), sessionKey: missingSession });
  await fixture.store.markMessagesRead({
    agentId: fixture.reader,
    messageIds: [],
    sessionKey: missingSession,
  });
  expect(
    Array.from(
      await fixture.admin`SELECT session_key FROM murmur.agent_sessions WHERE tenant_id = ${fixture.tenant.value}::uuid AND agent_id = ${fixture.reader.value} AND session_key = ${missingSession.value}`,
    ),
  ).toEqual([]);
  for (const sessionKey of [null, SESSION]) {
    await expect(
      fixture.store.getMessages({ ...query(fixture.otherReader), sessionKey }),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    await expect(
      fixture.store.markMessagesRead({ agentId: fixture.otherReader, messageIds: [], sessionKey }),
    ).rejects.toBeInstanceOf(UnknownAgentError);
  }
  await expect(fixture.other.getMessages(query(fixture.reader))).rejects.toBeInstanceOf(
    UnknownAgentError,
  );
  expect(await fixture.other.getMessages(query(fixture.otherReader))).toEqual([]);
}

test.skipIf(!postgresConfigured)(
  "PostgreSQL inbox transactions retain tenant, generation, session and read semantics without duplicate agent queries",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const first: SendMessageResult = await fixture.store.sendMessage({
        ...baseMessageCommand(),
        recipientId: fixture.reader,
        senderId: fixture.sender,
      });
      fixture.statements.length = 0;
      expect(
        (await fixture.store.getMessages(query(fixture.reader))).map(
          (message: Message): string => message.messageId.value,
        ),
      ).toEqual([first.message.messageId.value]);
      expectInboxTransactions(fixture.statements, 9);
      fixture.statements.length = 0;
      expect(
        await fixture.store.markMessagesRead({ agentId: fixture.reader, messageIds: [] }),
      ).toEqual({ readAt: fixture.now, updated: 0 });
      expectInboxTransactions(fixture.statements, 8);
      await verifySessionsAndIsolation(fixture);
      await fixture.store.closeAgent({
        agentId: fixture.reader,
        closeReason: "completed",
        expectedGeneration: AgentGeneration.parse(1),
      });
      expect(
        await fixture.store.markMessagesRead({
          agentId: fixture.reader,
          messageIds: [],
          sessionKey: SESSION,
        }),
      ).toEqual({ readAt: fixture.clock.now(), updated: 0 });
      expect(
        (
          await fixture.store.registerAgent({
            agentId: fixture.reader,
            displayName: DisplayName.parse("Reopened reader"),
            metadata: {},
            sessionKey: SESSION,
          })
        ).agent.generation.value,
      ).toBe(2);
      const second: SendMessageResult = await fixture.store.sendMessage({
        ...baseMessageCommand(),
        idempotencyKey: IdempotencyKey.parse("generation-two"),
        recipientId: fixture.reader,
        senderId: fixture.sender,
      });
      expect(
        (await fixture.store.getMessages(query(fixture.reader))).map(
          (message: Message): string => message.messageId.value,
        ),
      ).toEqual([second.message.messageId.value]);
      expect(
        (
          await fixture.store.getMessages({
            ...query(fixture.reader),
            generation: AgentGeneration.parse(1),
          })
        ).map((message: Message): string => message.messageId.value),
      ).toEqual([first.message.messageId.value]);
      expect((await fixture.store.getInboxVersion(fixture.reader)).value).toBe(
        second.message.sequence.value,
      );
      expect(
        (
          await fixture.store.markMessagesRead({
            agentId: fixture.reader,
            generation: AgentGeneration.parse(1),
            messageIds: [second.message.messageId],
          })
        ).updated,
      ).toBe(0);
      expect(
        (
          await fixture.other.markMessagesRead({
            agentId: fixture.otherReader,
            messageIds: [second.message.messageId],
          })
        ).updated,
      ).toBe(0);
      fixture.statements.length = 0;
      expect(
        (
          await fixture.store.markMessagesRead({
            agentId: fixture.reader,
            messageIds: [second.message.messageId],
          })
        ).updated,
      ).toBe(1);
      expectInboxTransactions(fixture.statements, 9);
      expect(
        await fixture.store.getMessages({ ...query(fixture.reader), unreadOnly: true }),
      ).toEqual([]);
      expect(
        await fixture.store.getMessages({
          ...query(fixture.reader),
          generation: AgentGeneration.parse(1),
          unreadOnly: true,
        }),
      ).toHaveLength(1);
    });
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "PostgreSQL operation failure cannot roll back previously committed expiration and quota reclamation",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const sent: SendMessageResult = await fixture.store.sendMessage({
        ...baseMessageCommand(),
        recipientId: fixture.reader,
        senderId: fixture.sender,
      });
      const expiresAt: Instant = fixture.now.addDays(30);
      fixture.clock.set(expiresAt);
      await fixture.admin`
        UPDATE murmur.agents SET last_seen_at = ${expiresAt.toISOString()}::timestamptz
        WHERE tenant_id = ${fixture.tenant.value}::uuid
      `;
      expect(sent.message.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      expect(
        Array.from(
          await fixture.admin`
          SELECT message_count::int AS count FROM murmur.tenant_resource_usage
          WHERE tenant_id = ${fixture.tenant.value}::uuid
        `,
        ),
      ).toEqual([{ count: 1 }]);
      fixture.statements.length = 0;
      await expect(
        fixture.store.getMessagesWithVersion(query(fixture.otherReader)),
      ).rejects.toBeInstanceOf(UnknownAgentError);
      expect(
        Array.from(
          await fixture.admin`
          SELECT message_id FROM murmur.messages
          WHERE tenant_id = ${fixture.tenant.value}::uuid
        `,
        ),
      ).toEqual([]);
      expect(
        Array.from(
          await fixture.admin`
          SELECT message_count::int AS count FROM murmur.tenant_resource_usage
          WHERE tenant_id = ${fixture.tenant.value}::uuid
        `,
        ),
      ).toEqual([{ count: 0 }]);
      expect(
        fixture.statements.filter((statement: string): boolean => statement.trim() === "commit"),
      ).toHaveLength(3);
      expect(
        fixture.statements.filter((statement: string): boolean => statement.trim() === "rollback"),
      ).toHaveLength(1);
      expect(
        fixture.statements.filter((statement: string): boolean =>
          statement.includes("AS candidates"),
        ),
      ).toHaveLength(1);
    });
  },
  20_000,
);
