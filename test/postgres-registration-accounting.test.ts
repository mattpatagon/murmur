import { expect, test } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { AgentAuthorityConflictError } from "../src/domain/errors.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { RegisterAgentCommand, RegisterAgentResult } from "../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  type Instant,
  Sequence,
  SystemClock,
  TenantId,
} from "../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import { PostgresInboxDispatcher } from "../src/storage/postgres-inbox-dispatcher.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";
import { baseMessageCommand, MutableClock } from "./support/store-fixture.js";

type Counters = {
  readonly accountedRows: number;
  readonly accountingCalls: number;
  readonly agentInserts: number;
  readonly agentUpdates: number;
};
const CountersSchema: z.ZodType<[Counters]> = z.tuple([
  z.strictObject({
    accountedRows: z.coerce.number().int().nonnegative().safe(),
    accountingCalls: z.coerce.number().int().nonnegative().safe(),
    agentInserts: z.coerce.number().int().nonnegative().safe(),
    agentUpdates: z.coerce.number().int().nonnegative().safe(),
  }),
]);
type Fixture = {
  readonly clock: MutableClock;
  readonly command: RegisterAgentCommand;
  readonly counters: Counters[];
  readonly statements: string[];
  readonly store: PostgresMessageStore;
};

async function readCounters(transaction: TransactionSql): Promise<Counters> {
  const raw: unknown = await transaction`
    SELECT
      COALESCE((SELECT n_tup_ins FROM pg_stat_xact_user_tables WHERE relid = 'murmur.agents'::regclass), 0) AS "agentInserts",
      COALESCE((SELECT n_tup_upd FROM pg_stat_xact_user_tables WHERE relid = 'murmur.agents'::regclass), 0) AS "agentUpdates",
      COALESCE((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid = 'murmur.account_hosted_storage_change()'::regprocedure), 0) AS "accountingCalls",
      COALESCE((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid = 'murmur.hosted_storage_row_bytes(jsonb)'::regprocedure), 0) AS "accountedRows"
  `;
  return CountersSchema.parse(raw)[0];
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (adminDatabaseUrl === undefined)
    throw new Error("Disposable PostgreSQL administrator URL is required");
  const tenant: TenantId = TenantId.generate();
  const clock: MutableClock = new MutableClock(new SystemClock().now());
  const counters: Counters[] = [];
  const statements: string[] = [];
  const admin: Sql = postgres(adminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const runtime: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    debug: (_connection: number, query: string): void => {
      statements.push(query);
    },
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const database: Sql = new Proxy(runtime, {
    get: (target: Sql, property: string | symbol, receiver: unknown): unknown => {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return async (operation: unknown): Promise<unknown> => {
        if (typeof operation !== "function") throw new Error("Unexpected registration transaction");
        return await runtime.begin(async (transaction: TransactionSql): Promise<unknown> => {
          const role: unknown =
            await transaction`SELECT current_user AS name, rolsuper, rolbypassrls
            FROM pg_catalog.pg_roles WHERE rolname = current_user`;
          expect(role).toEqual([{ name: "murmur_app", rolbypassrls: false, rolsuper: false }]);
          const before: Counters = await readCounters(transaction);
          const result: unknown = await Reflect.apply(operation, undefined, [transaction]);
          const after: Counters = await readCounters(transaction);
          counters.push({
            accountedRows: after.accountedRows - before.accountedRows,
            accountingCalls: after.accountingCalls - before.accountingCalls,
            agentInserts: after.agentInserts - before.agentInserts,
            agentUpdates: after.agentUpdates - before.agentUpdates,
          });
          return result;
        });
      };
    },
  });
  const candidate: unknown = Reflect.construct(PostgresMessageStore, [
    database,
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
  if (!(candidate instanceof PostgresMessageStore)) throw new Error("Invalid registration fixture");
  const store: PostgresMessageStore = candidate;
  try {
    // Function counters require an owner setting; all API work subsequently runs as murmur_app.
    await runtime`SET track_functions = 'all'`;
    await runtime`SET ROLE murmur_app`;
    await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
      VALUES (${tenant.value}::uuid, ${`registration-accounting-${tenant.value}`}, 'Registration accounting fixture')`;
    const command: RegisterAgentCommand = {
      agentId: AgentId.parse(`registration:${tenant.value}`),
      displayName: DisplayName.parse("Registration accounting actor"),
      metadata: { repository: "fixture/original" },
    };
    await run({ clock, command, counters, statements, store });
  } finally {
    try {
      await store.close();
    } finally {
      try {
        await admin.begin(async (transaction: TransactionSql): Promise<void> => {
          await transaction`DELETE FROM murmur.messages WHERE tenant_id = ${tenant.value}::uuid`;
          await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${tenant.value}::uuid`;
          await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenant.value}::uuid`;
          await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenant.value}::uuid`;
          await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${tenant.value}::uuid`;
        });
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }
}

test.skipIf(adminDatabaseUrl === undefined)(
  "new PostgreSQL registration avoids re-updating and re-accounting the agent it just inserted",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const result: RegisterAgentResult = await fixture.store.registerAgent(fixture.command);
      expect(result.agent.lastSeenAt.toISOString()).toBe(fixture.clock.now().toISOString());
      expect(result.agent.liveSessionCount).toBe(1);
      // Only the inserted agent and session are measured; fixed-size usage UPDATE is uncharged.
      expect(fixture.counters).toEqual([
        { accountedRows: 2, accountingCalls: 5, agentInserts: 1, agentUpdates: 0 },
      ]);
      expect(
        fixture.statements.filter((statement: string): boolean =>
          statement.includes("UPDATE murmur.agents SET last_seen_at ="),
        ),
      ).toHaveLength(0);
    });
  },
  15_000,
);

test.skipIf(adminDatabaseUrl === undefined)(
  "existing PostgreSQL registration changes its agent once while retaining named leases and generation rollover",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const initial: Instant = fixture.clock.now();
      await fixture.store.registerAgent(fixture.command);
      fixture.counters.length = 0;
      fixture.statements.length = 0;
      fixture.clock.set(initial.addMinutes(5));
      const sessionKey: SessionKey = SessionKey.parse("accounting-pane");
      const refreshed: RegisterAgentResult = await fixture.store.registerAgent({
        ...fixture.command,
        sessionKey,
      });
      expect(refreshed.agent.lastSeenAt.toISOString()).toBe(fixture.clock.now().toISOString());
      expect(refreshed.agent.liveSessionCount).toBe(2);
      expect(refreshed.agent.generation.value).toBe(1);
      expect(fixture.counters).toEqual([
        { accountedRows: 3, accountingCalls: 6, agentInserts: 0, agentUpdates: 1 },
      ]);
      expect(
        fixture.statements.filter((statement: string): boolean =>
          statement.includes("UPDATE murmur.agents SET last_seen_at ="),
        ),
      ).toHaveLength(0);
      fixture.clock.set(initial.addMinutes(10));
      const divergent: RegisterAgentResult = await fixture.store.registerAgent({
        ...fixture.command,
        metadata: { repository: "fixture/changed" },
        sessionKey,
      });
      expect(divergent.repositoryDiverged).toBe(true);
      expect(divergent.agent.metadata["repository"]).toBe("fixture/original");
      expect(divergent.agent.lastSeenAt.toISOString()).toBe(fixture.clock.now().toISOString());
      await expect(
        fixture.store.registerAgent({ ...fixture.command, authority: "orchestrator" }),
      ).rejects.toBeInstanceOf(AgentAuthorityConflictError);
      await fixture.store.closeAgent({
        agentId: fixture.command.agentId,
        closeReason: "completed",
        expectedGeneration: AgentGeneration.parse(1),
      });
      const reopened: RegisterAgentResult = await fixture.store.registerAgent({
        ...fixture.command,
        sessionKey,
      });
      expect(reopened.reopened).toBe(true);
      expect(reopened.agent.generation.value).toBe(2);
      expect(reopened.agent.liveSessionCount).toBe(1);
      expect(reopened.agent.lastSeenAt.toISOString()).toBe(fixture.clock.now().toISOString());
    });
  },
  15_000,
);

test.skipIf(adminDatabaseUrl === undefined)(
  "PostgreSQL sending still advances sender activity after registration",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      await fixture.store.registerAgent(fixture.command);
      const recipient: AgentId = AgentId.parse(`${fixture.command.agentId.value}:recipient`);
      await fixture.store.registerAgent({ ...fixture.command, agentId: recipient });
      fixture.clock.set(fixture.clock.now().addMinutes(5));
      fixture.statements.length = 0;
      await fixture.store.sendMessage({
        ...baseMessageCommand(),
        recipientId: recipient,
        senderId: fixture.command.agentId,
      });
      const agent: Awaited<ReturnType<PostgresMessageStore["getAgent"]>> =
        await fixture.store.getAgent(fixture.command.agentId);
      if (agent === null) throw new Error("Expected registered sender");
      expect(agent.lastSeenAt.toISOString()).toBe(fixture.clock.now().toISOString());
      expect(agent.leaseExpiresAt).toEqual(fixture.clock.now().addMinutes(60));
      expect(
        fixture.statements.filter((statement: string): boolean =>
          statement.includes("UPDATE murmur.agents SET last_seen_at ="),
        ),
      ).toHaveLength(1);
    });
  },
  15_000,
);
