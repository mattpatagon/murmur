import { expect, test } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { AgentAuthorityConflictError } from "../src/domain/errors.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { Agent, RegisterAgentCommand, RegisterAgentResult } from "../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  Instant,
  Sequence,
  SystemClock,
  TenantId,
} from "../src/domain/value-objects.js";
import { callDataTool, type DataToolContext } from "../src/mcp/murmur-data-tools.js";
import { POSTGRES_RUNTIME_POOL } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { PostgresInboxDispatcher } from "../src/storage/postgres-inbox-dispatcher.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { setPostgresTenantContext } from "../src/storage/postgres-message-transactions.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";
import { MutableClock } from "./support/store-fixture.js";

type Fixture = {
  readonly app: Sql;
  readonly clock: MutableClock;
  readonly command: RegisterAgentCommand;
  readonly connections: Set<number>;
  readonly other: MessageStore;
  readonly otherTenant: TenantId;
  readonly statements: string[];
  readonly store: PostgresMessageStore;
  readonly tenant: TenantId;
};
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

async function cleanTenants(admin: Sql, tenants: readonly TenantId[]): Promise<void> {
  let failed: boolean = false;
  for (const tenant of tenants) {
    try {
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${tenant.value}::uuid`;
      });
    } catch (_error: unknown) {
      // Attempt the other generated tenant even when this fixture's cleanup fails.
      failed = true;
    }
  }
  if (failed) throw new Error("PostgreSQL activation fixture cleanup failed");
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("PostgreSQL URLs are required");
  const tenant: TenantId = TenantId.generate();
  const otherTenant: TenantId = TenantId.generate();
  const clock: MutableClock = new MutableClock(new SystemClock().now());
  const statements: string[] = [];
  const connections: Set<number> = new Set<number>();
  const admin: Sql = postgres(adminDatabaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    debug: (connection: number, statement: string): void => {
      statements.push(statement);
      if (statement.trim() === "begin") connections.add(connection);
    },
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  // Observe the real runtime pool without creating a background notification listener.
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
    throw new Error("Invalid PostgreSQL activation fixture");
  const store: PostgresMessageStore = candidate;
  try {
    expect(
      Array.from(
        await app`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`,
      ),
    ).toEqual([{ name: "murmur_app", rolsuper: false, rolbypassrls: false }]);
    expect(
      Array.from(
        await app`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class WHERE oid IN ('murmur.agents'::regclass, 'murmur.agent_sessions'::regclass) ORDER BY relname`,
      ),
    ).toEqual([
      { relname: "agent_sessions", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "agents", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    for (const id of [tenant, otherTenant]) {
      await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name) VALUES (${id.value}::uuid, ${`registration-activation-${id.value}`}, 'Registration activation fixture')`;
    }
    const command: RegisterAgentCommand = {
      agentId: AgentId.parse(`activation:${tenant.value}`),
      displayName: DisplayName.parse("First tenant actor"),
      metadata: { repository: "fixture/original" },
    };
    await run({
      app,
      clock,
      command,
      connections,
      other: store.scope(otherTenant),
      otherTenant,
      statements,
      store,
      tenant,
    });
  } finally {
    try {
      await store.close();
    } finally {
      try {
        await cleanTenants(admin, [tenant, otherTenant]);
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }
}

function requireAgent(agent: Agent | null): Agent {
  if (agent === null) throw new Error("Expected registered activation actor");
  return agent;
}

async function verifyDirectRls(fixture: Fixture): Promise<void> {
  const actor: string = fixture.command.agentId.value;
  expect(
    Array.from(
      await fixture.app`SELECT tenant_id::text FROM murmur.agents WHERE agent_id = ${actor}`,
    ),
  ).toEqual([]);
  expect(
    Array.from(
      await fixture.app`SELECT tenant_id::text FROM murmur.agent_sessions WHERE agent_id = ${actor}`,
    ),
  ).toEqual([]);
  await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
    await setPostgresTenantContext(transaction, fixture.tenant);
    expect(
      Array.from(
        await transaction`SELECT tenant_id::text FROM murmur.agents WHERE agent_id = ${actor}`,
      ),
    ).toEqual([{ tenant_id: fixture.tenant.value }]);
    expect(
      Array.from(
        await transaction`SELECT tenant_id::text FROM murmur.agent_sessions WHERE agent_id = ${actor}`,
      ),
    ).toEqual([{ tenant_id: fixture.tenant.value }]);
    expect(
      Array.from(
        await transaction`UPDATE murmur.agents SET display_name = 'Foreign mutation rejected' WHERE tenant_id = ${fixture.otherTenant.value}::uuid AND agent_id = ${actor} RETURNING agent_id`,
      ),
    ).toEqual([]);
    expect(
      Array.from(
        await transaction`UPDATE murmur.agent_sessions SET ended_at = lease_expires_at, end_reason = 'stop' WHERE tenant_id = ${fixture.otherTenant.value}::uuid AND agent_id = ${actor} RETURNING agent_id`,
      ),
    ).toEqual([]);
  });
}

test.skipIf(!postgresConfigured)(
  "concurrent PostgreSQL registration publishes one activation and isolates identical tenant-local IDs",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      fixture.connections.clear();
      const registrations: RegisterAgentResult[] = await Promise.all(
        Array.from(
          { length: 8 },
          async (): Promise<RegisterAgentResult> =>
            await fixture.store.registerAgent(fixture.command),
        ),
      );
      expect(
        registrations.filter((result: RegisterAgentResult): boolean => result.becameActive),
      ).toHaveLength(1);
      expect(
        registrations.every(
          (result: RegisterAgentResult): boolean =>
            result.agent.state === "active" &&
            result.agent.generation.value === 1 &&
            result.agent.liveSessionCount === 1,
        ),
      ).toBe(true);
      expect(fixture.connections.size).toBeGreaterThan(1);
      const other: RegisterAgentResult = await fixture.other.registerAgent({
        ...fixture.command,
        displayName: DisplayName.parse("Other tenant actor"),
      });
      expect(other.becameActive).toBe(true);
      await verifyDirectRls(fixture);
      await fixture.store.closeAgent({
        agentId: fixture.command.agentId,
        closeReason: "manual",
        expectedGeneration: AgentGeneration.parse(1),
      });
      const reopened: RegisterAgentResult = await fixture.store.registerAgent(fixture.command);
      expect(reopened.becameActive).toBe(true);
      expect(reopened.reopened).toBe(true);
      expect(reopened.agent.generation.value).toBe(2);
      const unaffected: Agent = requireAgent(await fixture.other.getAgent(fixture.command.agentId));
      expect(unaffected.displayName.value).toBe("Other tenant actor");
      expect(unaffected.generation.value).toBe(1);
      expect(unaffected.state).toBe("active");
      await expect(
        fixture.store.registerAgent({ ...fixture.command, authority: "orchestrator" }),
      ).rejects.toBeInstanceOf(AgentAuthorityConflictError);
      expect((await fixture.store.registerAgent(fixture.command)).becameActive).toBe(false);
    });
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "PostgreSQL activation follows exact expiry, ended leases, repository changes, and dormant generation preservation",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const initial: Instant = fixture.clock.now();
      expect((await fixture.store.registerAgent(fixture.command)).becameActive).toBe(true);
      const boundaryActor: RegisterAgentCommand = {
        ...fixture.command,
        agentId: AgentId.parse(`${fixture.command.agentId.value}:boundary`),
      };
      await fixture.store.registerAgent(boundaryActor);
      fixture.clock.set(
        Instant.fromDate(new Date(initial.addMinutes(60).toEpochMilliseconds() - 1)),
      );
      expect((await fixture.store.registerAgent(fixture.command)).becameActive).toBe(false);
      fixture.clock.set(initial.addMinutes(60));
      expect(requireAgent(await fixture.store.getAgent(boundaryActor.agentId)).state).toBe(
        "inactive",
      );
      const boundary: RegisterAgentResult = await fixture.store.registerAgent(boundaryActor);
      expect(boundary.becameActive).toBe(true);
      expect(boundary.reopened).toBe(false);
      expect(boundary.agent.generation.value).toBe(1);
      const pane: SessionKey = SessionKey.parse("activation-pane");
      expect(
        (await fixture.store.registerAgent({ ...fixture.command, sessionKey: pane })).becameActive,
      ).toBe(false);
      await fixture.store.endSession({
        agentId: fixture.command.agentId,
        endDefaultSession: true,
        endReason: "stop",
        expectedGeneration: AgentGeneration.parse(1),
        sessionKey: pane,
      });
      const returned: RegisterAgentResult = await fixture.store.registerAgent(fixture.command);
      expect(returned.becameActive).toBe(true);
      expect(returned.reopened).toBe(false);
      const changed: RegisterAgentCommand = {
        ...fixture.command,
        metadata: { repository: "fixture/changed" },
      };
      const divergent: RegisterAgentResult = await fixture.store.registerAgent(changed);
      expect(divergent.becameActive).toBe(false);
      expect(divergent.repositoryDiverged).toBe(true);
      expect(divergent.agent.metadata["repository"]).toBe("fixture/original");
      fixture.clock.set(fixture.clock.now().addMinutes(60));
      const switched: RegisterAgentResult = await fixture.store.registerAgent(changed);
      expect(switched.becameActive).toBe(true);
      expect(switched.reopened).toBe(true);
      expect(switched.agent.generation.value).toBe(2);
      fixture.clock.set(fixture.clock.now().addDays(30));
      await fixture.store.pruneExpired(fixture.clock.now());
      const dormant: Agent = requireAgent(await fixture.store.getAgent(fixture.command.agentId));
      expect(dormant.state).toBe("closed");
      expect(dormant.closeReason).toBe("dormant");
      const resumed: RegisterAgentResult = await fixture.store.registerAgent(changed);
      expect(resumed.becameActive).toBe(true);
      expect(resumed.reopened).toBe(true);
      expect(resumed.agent.generation.value).toBe(2);
    });
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "real PostgreSQL MCP registration removes the four/five-statement preread transaction",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      // Warm driver type discovery before measuring protocol statements, not operation results.
      await fixture.store.registerAgent({
        ...fixture.command,
        agentId: AgentId.parse(`${fixture.command.agentId.value}:warm`),
      });
      let changes: number = 0;
      const context: DataToolContext = {
        boundAgentId: null,
        branchName: null,
        client: null,
        legacyMessageShape: false,
        notifyResourceListChanged: async (): Promise<void> => {
          changes += 1;
        },
        recordRepositoryDivergence: (): void => {},
        repositoryName: null,
        senderAuthority: "peer",
        store: fixture.store,
      };
      for (let index: number = 0; index < 2; index += 1) {
        fixture.statements.length = 0;
        await callDataTool("register_agent", { agent_id: fixture.command.agentId.value }, context);
        expect(fixture.statements).toHaveLength(14);
        expect(
          fixture.statements.filter((statement: string): boolean => statement.trim() === "begin"),
        ).toHaveLength(1);
        expect(
          fixture.statements.filter((statement: string): boolean => statement.trim() === "commit"),
        ).toHaveLength(1);
        expect(
          fixture.statements.filter((statement: string): boolean =>
            statement.includes("session.live_session_count"),
          ),
        ).toHaveLength(1);
        expect(changes).toBe(1);
      }
    });
  },
  20_000,
);
