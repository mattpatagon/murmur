import { expect, test } from "bun:test";

import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { Agent, RegisterAgentCommand, RegisterAgentResult } from "../src/domain/models.js";
import { AgentId, Instant } from "../src/domain/value-objects.js";
import { callDataTool, type DataToolContext } from "../src/mcp/murmur-data-tools.js";
import { adminDatabaseUrl, databaseUrl } from "./support/hosted-mcp-harness.js";
import {
  type RegistrationFixture,
  requireRegistrationAgent,
  verifyRegistrationIsolation,
  withRegistrationFixture,
} from "./support/postgres-registration-transactions.js";

const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

test.skipIf(!postgresConfigured)(
  "concurrent PostgreSQL registration publishes one activation and isolates tenants",
  async (): Promise<void> => {
    await withRegistrationFixture(async (fixture: RegistrationFixture): Promise<void> => {
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
      // Discovery can run before bootstrap replaces the v1 globally unique agent key.
      await verifyRegistrationIsolation(
        fixture,
        AgentId.parse(`activation:${fixture.otherTenant.value}`),
      );
    });
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "PostgreSQL activation follows exact expiry, ended leases, repository changes, and dormant generation preservation",
  async (): Promise<void> => {
    await withRegistrationFixture(async (fixture: RegistrationFixture): Promise<void> => {
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
      expect(
        requireRegistrationAgent(await fixture.store.getAgent(boundaryActor.agentId)).state,
      ).toBe("inactive");
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
      const dormant: Agent = requireRegistrationAgent(
        await fixture.store.getAgent(fixture.command.agentId),
      );
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
    await withRegistrationFixture(async (fixture: RegistrationFixture): Promise<void> => {
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
