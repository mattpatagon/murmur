import { expect, spyOn, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { AgentAuthorityConflictError } from "../src/domain/errors.js";
import type { RegisterAgentCommand, RegisterAgentResult } from "../src/domain/models.js";
import { AgentId, DisplayName, Instant, Sequence, TenantId } from "../src/domain/value-objects.js";
import { callDataTool, type DataToolContext } from "../src/mcp/murmur-data-tools.js";
import { PostgresInboxDispatcher } from "../src/storage/postgres-inbox-dispatcher.js";
import type { AgentRow } from "../src/storage/postgres-message-rows.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";

const NOW: Instant = Instant.parse("2026-01-01T01:00:00.000Z");
const COMMAND: RegisterAgentCommand = {
  agentId: AgentId.parse("registration:query-actor"),
  displayName: DisplayName.parse("Query actor"),
  metadata: { repository: "fixture/original" },
};
const ACTIVE: AgentRow = {
  agent_id: COMMAND.agentId.value,
  authority: "peer",
  closed_at: null,
  close_reason: null,
  created_at: NOW.toISOString(),
  display_name: COMMAND.displayName.value,
  generation: 1,
  last_seen_at: NOW.toISOString(),
  lease_expires_at: NOW.addMinutes(60).toISOString(),
  live_session_count: 1,
  metadata_json: JSON.stringify(COMMAND.metadata),
  state: "active",
};

class RegistrationFixture {
  public readonly store: PostgresMessageStore;
  public readonly statements: string[] = [];
  public readonly tenant: TenantId = TenantId.generate();
  public changes: number = 0;
  public divergences: number = 0;
  public countResult: unknown = null;
  public returned: AgentRow = ACTIVE;
  private mutated: boolean = false;

  public constructor(public readonly previous: AgentRow | null) {
    // Only the driver's local SQL helpers are used; every transaction is intercepted.
    const database: Sql = postgres({ host: "127.0.0.1", max: 1, port: 1 });
    Reflect.set(
      database,
      "begin",
      async (run: (query: unknown) => Promise<unknown>): Promise<unknown> => {
        this.statements.push("BEGIN");
        try {
          const result: unknown = await run(
            async (
              strings: TemplateStringsArray,
              ...values: readonly unknown[]
            ): Promise<unknown> => {
              const sql: string = strings.join("?");
              this.statements.push(sql);
              expect(values).toContain(this.tenant.value);
              return this.rows(sql);
            },
          );
          this.statements.push("COMMIT");
          return result;
        } catch (error: unknown) {
          this.statements.push("ROLLBACK");
          throw error;
        }
      },
    );
    const candidate: unknown = Reflect.construct(PostgresMessageStore, [
      database,
      { now: (): Instant => NOW },
      this.tenant,
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
      throw new Error("Invalid registration fixture");
    this.store = candidate;
  }

  private rows(sql: string): unknown {
    if (sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("SELECT authority, generation")) {
      const row: AgentRow | null = this.mutated ? this.returned : this.previous;
      return row === null
        ? []
        : [
            {
              authority: row.authority,
              closed_at: row.closed_at,
              close_reason: row.close_reason,
              generation: row.generation,
              metadata_json: row.metadata_json,
            },
          ];
    }
    if (sql.includes("session.live_session_count")) {
      return this.mutated ? [this.returned] : this.previous === null ? [] : [this.previous];
    }
    if (sql.includes("INSERT INTO murmur.agents(") || sql.includes("UPDATE murmur.agents SET")) {
      this.mutated = true;
      return [];
    }
    if (sql.includes("SELECT COUNT(*)::int AS count")) {
      return (
        this.countResult ?? [
          { count: this.previous === null ? 0 : this.previous.live_session_count },
        ]
      );
    }
    if (sql.includes("SELECT 1 AS present")) {
      return this.previous !== null && this.previous.state === "active" ? [{ present: 1 }] : [];
    }
    if (
      sql.includes("UPDATE murmur.agent_sessions") ||
      sql.includes("INSERT INTO murmur.agent_sessions") ||
      sql.includes("WITH counts AS")
    )
      return [];
    throw new Error("Unexpected registration fixture query");
  }

  public context(): DataToolContext {
    return {
      boundAgentId: null,
      branchName: null,
      client: null,
      legacyMessageShape: false,
      notifyResourceListChanged: async (): Promise<void> => {
        this.changes += 1;
      },
      recordRepositoryDivergence: (): void => {
        this.divergences += 1;
      },
      repositoryName: null,
      senderAuthority: "peer",
      store: this.store,
    };
  }
}

for (const previous of [null, ACTIVE]) {
  test(`PostgreSQL ${previous === null ? "new" : "active"} MCP registration uses one 14-statement transaction`, async (): Promise<void> => {
    const fixture: RegistrationFixture = new RegistrationFixture(previous);
    const lookup: ReturnType<typeof spyOn<PostgresMessageStore, "getAgent">> = spyOn(
      fixture.store,
      "getAgent",
    );
    try {
      const result: unknown = await callDataTool(
        "register_agent",
        { agent_id: COMMAND.agentId.value },
        fixture.context(),
      );
      expect(result).not.toBeNull();
      expect(lookup).not.toHaveBeenCalled();
      expect(fixture.statements).toHaveLength(14);
      expect(fixture.statements.filter((sql: string): boolean => sql === "BEGIN")).toHaveLength(1);
      expect(fixture.statements[0]).toBe("BEGIN");
      expect(fixture.statements[13]).toBe("COMMIT");
      expect(fixture.statements[1]).toContain("set_config");
      expect(fixture.statements[2]).toContain("pg_advisory_xact_lock");
      expect(fixture.changes).toBe(previous === null ? 1 : 0);
    } finally {
      lookup.mockRestore();
      await fixture.store.close();
    }
  });
}

for (const state of ["inactive", "closed"]) {
  test(`PostgreSQL ${state} registration reuses its existing live-session count for activation`, async (): Promise<void> => {
    const fixture: RegistrationFixture = new RegistrationFixture({
      ...ACTIVE,
      closed_at: state === "closed" ? NOW.toISOString() : null,
      close_reason: state === "closed" ? "dormant" : null,
      lease_expires_at: null,
      live_session_count: 0,
      state,
    });
    try {
      const result: RegisterAgentResult = await fixture.store.registerAgent(COMMAND);
      expect(result.becameActive).toBe(true);
      expect(result.reopened).toBe(state === "closed");
      expect(result.agent.generation.value).toBe(1);
      expect(
        fixture.statements.filter((sql: string): boolean =>
          sql.includes("SELECT COUNT(*)::int AS count"),
        ),
      ).toHaveLength(2);
      const countIndex: number = fixture.statements.findIndex((sql: string): boolean =>
        sql.includes("SELECT COUNT(*)::int AS count"),
      );
      const mutationIndex: number = fixture.statements.findIndex((sql: string): boolean =>
        sql.includes("UPDATE murmur.agents SET"),
      );
      expect(countIndex).toBeLessThan(mutationIndex);
      expect(fixture.statements[countIndex]).toContain("generation =");
      expect(fixture.statements[countIndex]).toContain("ended_at IS NULL");
      expect(fixture.statements[countIndex]).toContain("lease_expires_at >");
    } finally {
      await fixture.store.close();
    }
  });
}

test("PostgreSQL active divergence retains telemetry without a resource-list notification", async (): Promise<void> => {
  const fixture: RegistrationFixture = new RegistrationFixture(ACTIVE);
  try {
    await callDataTool(
      "register_agent",
      { agent_id: COMMAND.agentId.value, metadata: { repository: "fixture/changed" } },
      fixture.context(),
    );
    expect(fixture.changes).toBe(0);
    expect(fixture.divergences).toBe(1);
  } finally {
    await fixture.store.close();
  }
});

test("PostgreSQL registration preserves authority and row validation before publishing activation", async (): Promise<void> => {
  for (const fault of ["authority", "count", "agent"]) {
    const fixture: RegistrationFixture = new RegistrationFixture(
      fault === "authority" ? { ...ACTIVE, authority: "orchestrator" } : ACTIVE,
    );
    if (fault === "count") fixture.countResult = [{ count: -1 }];
    if (fault === "agent") fixture.returned = { ...ACTIVE, live_session_count: -1 };
    try {
      const operation: Promise<unknown> = callDataTool(
        "register_agent",
        { agent_id: COMMAND.agentId.value },
        fixture.context(),
      );
      if (fault === "authority")
        await expect(operation).rejects.toBeInstanceOf(AgentAuthorityConflictError);
      else await expect(operation).rejects.toThrow();
      expect(fixture.changes).toBe(0);
      expect(fixture.statements.at(-1)).toBe("ROLLBACK");
    } finally {
      await fixture.store.close();
    }
  }
});
