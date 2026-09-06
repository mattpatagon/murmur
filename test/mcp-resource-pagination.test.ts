import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ListResourcesResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type GetAgentInput,
  type GetAgentOutput,
  type ListAgentsInput,
  type ListAgentsOutput,
  listAgentsQuery,
  toAgentDto,
  toListAgentsOutput,
} from "../src/domain/agent-contracts.js";
import type { Agent } from "../src/domain/models.js";
import { AgentId, DisplayName } from "../src/domain/value-objects.js";
import { E2eeProxyResources } from "../src/e2ee/proxy-resources.js";
import type { E2eeProxyOperations } from "../src/e2ee/proxy-service.js";
import { MurmurInboxResources } from "../src/mcp/murmur-inbox-resources.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

class PaginationOperations implements E2eeProxyOperations {
  public readonly cursors: (string | undefined)[] = [];
  private readonly store: SqliteMessageStore;

  public constructor(store: SqliteMessageStore) {
    this.store = store;
  }
  public async listAgents(input: ListAgentsInput): Promise<ListAgentsOutput> {
    this.cursors.push(input.cursor);
    return toListAgentsOutput(this.store.listAgents(listAgentsQuery(input)));
  }
  public async getAgent(input: GetAgentInput): Promise<GetAgentOutput> {
    const agent: Agent | null = this.store.getAgent(AgentId.parse(input.agent_id));
    if (agent === null) throw new Error("Unknown fixture agent");
    return { agent: toAgentDto(agent) };
  }
  public async registerAgent(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async endSession(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async closeAgent(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async submitFeedback(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async sendMessage(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async broadcastMessage(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async getMessages(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async waitForMessages(): Promise<never> {
    throw new Error("Fixture has no new messages");
  }
  public async markMessagesRead(): Promise<never> {
    throw new Error("Unused fixture operation");
  }
  public async close(): Promise<void> {}
}

type Fixture = { readonly client: Client; readonly operations: PaginationOperations };

async function withResources(
  encrypted: boolean,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
  const server: Server = new Server(
    { name: "page-test", version: "1.0.0" },
    { capabilities: { resources: { listChanged: true, subscribe: true } } },
  );
  const client: Client = new Client({ name: "page-client", version: "1.0.0" });
  const operations: PaginationOperations = new PaginationOperations(store);
  const resources: MurmurInboxResources | E2eeProxyResources = encrypted
    ? new E2eeProxyResources(server, operations)
    : new MurmurInboxResources(server, store, false);
  try {
    for (let index: number = 0; index < 300; index += 1) {
      const id: string = `agent-${index.toString().padStart(4, "0")}`;
      store.registerAgent({
        agentId: AgentId.parse(id),
        displayName: DisplayName.parse(id),
        metadata: { value: "x".repeat(16_000) },
      });
    }
    resources.registerHandlers();
    const pair: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(pair[0]);
    await client.connect(pair[1]);
    await run({ client, operations });
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await resources.close();
      } finally {
        try {
          await server.close();
        } finally {
          store.close();
        }
      }
    }
  }
}

for (const encrypted of [false, true]) {
  test(`resource pages preserve every inbox (encrypted=${encrypted})`, async (): Promise<void> => {
    await withResources(encrypted, async ({ client }: Fixture): Promise<void> => {
      const uris: string[] = [];
      let cursor: string | undefined;
      let pages: number = 0;
      do {
        const page: ListResourcesResult = await client.listResources({ cursor });
        uris.push(
          ...page.resources.map(
            (resource: ListResourcesResult["resources"][number]): string => resource.uri,
          ),
        );
        cursor = page.nextCursor;
        pages += 1;
        if (pages > 300) throw new Error("Resource pagination did not advance");
      } while (cursor !== undefined);
      expect(pages).toBeGreaterThan(1);
      expect(uris).toHaveLength(300);
      expect(new Set(uris).size).toBe(300);
      expect(uris.at(-1)).toBe("murmur://inbox/agent-0299");
      await expect(client.listResources({ cursor: "not-a-valid-cursor" })).rejects.toThrow();
    });
  });
}

test("encrypted subscriptions can address agents beyond the first page", async (): Promise<void> => {
  await withResources(true, async ({ client, operations }: Fixture): Promise<void> => {
    const uri: string = "murmur://inbox/agent-0299";
    await client.subscribeResource({ uri });
    await client.unsubscribeResource({ uri });
    expect(operations.cursors).toEqual([]);
  });
});
