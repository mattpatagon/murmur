import { expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { RegisterAgentOutputSchema } from "../src/domain/contracts.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { RegisterAgentResult } from "../src/domain/models.js";
import { AgentId, DisplayName, Instant } from "../src/domain/value-objects.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { callDataTool, type DataToolContext } from "../src/mcp/murmur-data-tools.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { callValidated } from "./support/mcp-client-harness.js";
import { MutableClock } from "./support/store-fixture.js";

const NOW: Instant = Instant.parse("2026-01-01T00:00:00.000Z");
const ACTOR: AgentId = AgentId.parse("activation:actor");

function register(
  store: SqliteMessageStore,
  repository: string = "fixture/original",
  session: string = "default",
): RegisterAgentResult {
  return store.registerAgent({
    agentId: ACTOR,
    displayName: DisplayName.parse("Activation actor"),
    metadata: { repository },
    sessionKey: SessionKey.parse(session),
  });
}

test("registration distinguishes first activation, active leases, and ended-session reactivation", (): void => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", new MutableClock(NOW));
  try {
    expect(register(store).becameActive).toBe(true);
    expect(register(store).becameActive).toBe(false);
    expect(register(store, "fixture/original", "pane").becameActive).toBe(false);
    store.endSession({
      agentId: ACTOR,
      endDefaultSession: true,
      endReason: "stop",
      expectedGeneration: AgentGeneration.parse(1),
      sessionKey: SessionKey.parse("pane"),
    });
    const returned: RegisterAgentResult = register(store);
    expect(returned.becameActive).toBe(true);
    expect(returned.reopened).toBe(false);
    expect(returned.agent.generation.value).toBe(1);
    expect(returned.agent.state).toBe("active");
  } finally {
    store.close();
  }
});

for (const timestamp of ["2026-01-01T00:59:59.999Z", "2026-01-01T01:00:00.000Z"]) {
  test(`registration activation uses the exact lease boundary at ${timestamp}`, (): void => {
    const clock: MutableClock = new MutableClock(NOW);
    const store: SqliteMessageStore = new SqliteMessageStore(":memory:", clock);
    try {
      register(store);
      clock.set(Instant.parse(timestamp));
      const result: RegisterAgentResult = register(store);
      expect(result.becameActive).toBe(timestamp === "2026-01-01T01:00:00.000Z");
      expect(result.agent.state).toBe("active");
      expect(result.reopened).toBe(false);
    } finally {
      store.close();
    }
  });
}

test("registration activation is independent of repository divergence and reopening generation", (): void => {
  const clock: MutableClock = new MutableClock(NOW);
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", clock);
  try {
    register(store);
    const divergent: RegisterAgentResult = register(store, "fixture/changed", "pane");
    expect(divergent.becameActive).toBe(false);
    expect(divergent.repositoryDiverged).toBe(true);
    expect(divergent.agent.metadata["repository"]).toBe("fixture/original");
    clock.set(NOW.addMinutes(60));
    const switched: RegisterAgentResult = register(store, "fixture/changed");
    expect(switched.becameActive).toBe(true);
    expect(switched.reopened).toBe(true);
    expect(switched.agent.generation.value).toBe(2);
    store.closeAgent({
      agentId: ACTOR,
      closeReason: "manual",
      expectedGeneration: AgentGeneration.parse(2),
    });
    const reopened: RegisterAgentResult = register(store, "fixture/changed");
    expect(reopened.becameActive).toBe(true);
    expect(reopened.agent.generation.value).toBe(3);
    clock.set(clock.now().addDays(30));
    store.pruneExpired(clock.now());
    const dormantReturn: RegisterAgentResult = register(store, "fixture/changed");
    expect(dormantReturn.becameActive).toBe(true);
    expect(dormantReturn.reopened).toBe(true);
    expect(dormantReturn.agent.generation.value).toBe(3);
  } finally {
    store.close();
  }
});

test("replacing a capped live session does not report another activation", (): void => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", new MutableClock(NOW));
  try {
    register(store);
    for (let index: number = 0; index < 9; index += 1) {
      expect(register(store, "fixture/original", `pane-${index}`).becameActive).toBe(false);
    }
    expect(register(store).agent.liveSessionCount).toBe(8);
  } finally {
    store.close();
  }
});

test("MCP sends only activation list changes with no getAgent preread or new wire field", async (): Promise<void> => {
  const clock: MutableClock = new MutableClock(NOW);
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", clock);
  const lookup: ReturnType<typeof spyOn<SqliteMessageStore, "getAgent">> = spyOn(store, "getAgent");
  lookup.mockImplementation((): never => {
    throw new Error("Registration must not perform an outer agent lookup");
  });
  const application: MurmurApplication = new MurmurApplication({
    branchName: null,
    client: null,
    repositoryName: null,
    store,
  });
  const client: Client = new Client({ name: "registration-activation", version: "1.0.0" });
  const [clientTransport, serverTransport]: [InMemoryTransport, InMemoryTransport] =
    InMemoryTransport.createLinkedPair();
  let changes: number = 0;
  client.setNotificationHandler(ResourceListChangedNotificationSchema, (): void => {
    changes += 1;
  });
  const call: () => Promise<void> = async (): Promise<void> => {
    const output: unknown = await callValidated(
      client,
      "register_agent",
      { agent_id: ACTOR.value },
      RegisterAgentOutputSchema,
    );
    expect(output).not.toHaveProperty("becameActive");
    expect(output).not.toHaveProperty("became_active");
  };
  try {
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    await call();
    expect(changes).toBe(1);
    await call();
    expect(changes).toBe(1);
    clock.set(NOW.addMinutes(60));
    await call();
    expect(changes).toBe(2);
    store.closeAgent({
      agentId: ACTOR,
      closeReason: "manual",
      expectedGeneration: AgentGeneration.parse(1),
    });
    await call();
    expect(changes).toBe(3);
    expect((await client.listResources()).resources).toHaveLength(1);
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
    try {
      await client.close();
    } finally {
      await application.close();
    }
  }
});

test("registration still rejects invalid or unauthorized commands before notifying", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", new MutableClock(NOW));
  let changes: number = 0;
  const context: DataToolContext = {
    boundAgentId: ACTOR,
    branchName: null,
    client: null,
    legacyMessageShape: false,
    notifyResourceListChanged: async (): Promise<void> => {
      changes += 1;
    },
    recordRepositoryDivergence: (): void => {},
    repositoryName: null,
    senderAuthority: "peer",
    store,
  };
  const registration: ReturnType<typeof spyOn<SqliteMessageStore, "registerAgent">> = spyOn(
    store,
    "registerAgent",
  );
  try {
    await expect(
      callDataTool("register_agent", { agent_id: "different" }, context),
    ).rejects.toThrow("bound to a different agent");
    await expect(
      callDataTool("register_agent", { agent_id: ACTOR.value, unexpected: true }, context),
    ).rejects.toThrow();
    expect(registration).not.toHaveBeenCalled();
    await expect(
      callDataTool(
        "register_agent",
        { agent_id: ACTOR.value },
        { ...context, senderAuthority: "orchestrator" },
      ),
    ).rejects.toThrow("cannot register orchestrator");
    expect(changes).toBe(0);
    expect(store.listAgents({ cursor: null, limit: 10, state: "all" }).agents).toHaveLength(0);
  } finally {
    registration.mockRestore();
    store.close();
  }
});
