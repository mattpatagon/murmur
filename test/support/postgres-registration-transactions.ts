import { expect } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { AgentAuthorityConflictError } from "../../src/domain/errors.js";
import { AgentGeneration } from "../../src/domain/lifecycle-values.js";
import type { Agent, RegisterAgentCommand, RegisterAgentResult } from "../../src/domain/models.js";
import {
  AgentId,
  DisplayName,
  Sequence,
  SystemClock,
  TenantId,
} from "../../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_POOL } from "../../src/postgres-runtime.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import type { MessageStore } from "../../src/storage/message-store.js";
import { PostgresInboxDispatcher } from "../../src/storage/postgres-inbox-dispatcher.js";
import { PostgresMessageStore } from "../../src/storage/postgres-message-store.js";
import { setPostgresTenantContext } from "../../src/storage/postgres-message-transactions.js";
import { adminDatabaseUrl, databaseUrl, testTlsConfiguration } from "./hosted-mcp-harness.js";
import { MutableClock } from "./store-fixture.js";

export type RegistrationFixture = {
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

export async function withRegistrationFixture(
  run: (fixture: RegistrationFixture) => Promise<void>,
): Promise<void> {
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

export function requireRegistrationAgent(agent: Agent | null): Agent {
  if (agent === null) throw new Error("Expected registered activation actor");
  return agent;
}

async function verifyDirectRls(fixture: RegistrationFixture, otherAgentId: AgentId): Promise<void> {
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
        await transaction`UPDATE murmur.agents SET display_name = 'Foreign mutation rejected' WHERE tenant_id = ${fixture.otherTenant.value}::uuid AND agent_id = ${otherAgentId.value} RETURNING agent_id`,
      ),
    ).toEqual([]);
    expect(
      Array.from(
        await transaction`UPDATE murmur.agent_sessions SET ended_at = lease_expires_at, end_reason = 'stop' WHERE tenant_id = ${fixture.otherTenant.value}::uuid AND agent_id = ${otherAgentId.value} RETURNING agent_id`,
      ),
    ).toEqual([]);
  });
}

export async function verifyRegistrationIsolation(
  fixture: RegistrationFixture,
  otherAgentId: AgentId,
): Promise<void> {
  const other: RegisterAgentResult = await fixture.other.registerAgent({
    ...fixture.command,
    agentId: otherAgentId,
    displayName: DisplayName.parse("Other tenant actor"),
  });
  expect(other.becameActive).toBe(true);
  await verifyDirectRls(fixture, otherAgentId);
  await fixture.store.closeAgent({
    agentId: fixture.command.agentId,
    closeReason: "manual",
    expectedGeneration: AgentGeneration.parse(1),
  });
  const reopened: RegisterAgentResult = await fixture.store.registerAgent(fixture.command);
  expect(reopened.becameActive).toBe(true);
  expect(reopened.reopened).toBe(true);
  expect(reopened.agent.generation.value).toBe(2);
  const unaffected: Agent = requireRegistrationAgent(await fixture.other.getAgent(otherAgentId));
  expect(unaffected.displayName.value).toBe("Other tenant actor");
  expect(unaffected.generation.value).toBe(1);
  expect(unaffected.state).toBe("active");
  await expect(
    fixture.store.registerAgent({ ...fixture.command, authority: "orchestrator" }),
  ).rejects.toBeInstanceOf(AgentAuthorityConflictError);
  expect((await fixture.store.registerAgent(fixture.command)).becameActive).toBe(false);
}

export async function verifyHostedRegistrationTenantIsolation(): Promise<void> {
  await withRegistrationFixture(async (fixture: RegistrationFixture): Promise<void> => {
    expect((await fixture.store.registerAgent(fixture.command)).becameActive).toBe(true);
    await verifyRegistrationIsolation(fixture, fixture.command.agentId);
  });
}
