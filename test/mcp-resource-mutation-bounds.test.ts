import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { registerAgentCommand } from "../src/domain/agent-contracts.js";
import type { Agent } from "../src/domain/models.js";
import type { AgentId } from "../src/domain/value-objects.js";
import { MurmurInboxResources } from "../src/mcp/murmur-inbox-resources.js";
import type { InboxSubscription, MessageStore } from "../src/storage/message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

type Barrier = { readonly promise: Promise<void>; readonly resolve: () => void };
const URI: string = "murmur://inbox/test%3Areader";

class ResourceBarriers {
  public readonly agentEntered: Barrier = Promise.withResolvers<void>();
  public readonly agentRelease: Barrier = Promise.withResolvers<void>();
  public readonly watchEntered: Barrier = Promise.withResolvers<void>();
  public readonly watchRelease: Barrier = Promise.withResolvers<void>();
  public agentCalls: number = 0;
  public watchCalls: number = 0;
  public activeWatchers: number = 0;
  public closedWatchers: number = 0;
  public holdAgent: boolean = true;
  public holdWatch: boolean = false;

  public async getAgent(store: MessageStore, agentId: AgentId): Promise<Agent | null> {
    this.agentCalls += 1;
    if (this.agentCalls === 1 && this.holdAgent) {
      this.agentEntered.resolve();
      await this.agentRelease.promise;
    }
    return await store.getAgent(agentId);
  }

  public async watch(): Promise<InboxSubscription> {
    this.watchCalls += 1;
    if (this.watchCalls === 1 && this.holdWatch) {
      this.watchEntered.resolve();
      await this.watchRelease.promise;
    }
    this.activeWatchers += 1;
    let closed: boolean = false;
    return {
      close: (): void => {
        if (closed) return;
        closed = true;
        this.activeWatchers -= 1;
        this.closedWatchers += 1;
      },
    };
  }
}

type Fixture = {
  readonly barriers: ResourceBarriers;
  readonly client: Client;
  readonly resources: MurmurInboxResources;
  readonly server: Server;
  readonly store: SqliteMessageStore;
};

async function connect(): Promise<Fixture> {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
  store.registerAgent(registerAgentCommand({ agent_id: "test:reader", display_name: "Reader" }));
  const barriers: ResourceBarriers = new ResourceBarriers();
  const facade: MessageStore = new Proxy<MessageStore>(store, {
    get: (target: MessageStore, property: string | symbol): unknown => {
      if (property === "getAgent") {
        return async (agentId: AgentId): Promise<Agent | null> =>
          await barriers.getAgent(target, agentId);
      }
      if (property === "watchInbox") {
        return async (): Promise<InboxSubscription> => await barriers.watch();
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const server: Server = new Server(
    { name: "resource-mutation-test", version: "1.0.0" },
    { capabilities: { resources: { subscribe: true } } },
  );
  const resources: MurmurInboxResources = new MurmurInboxResources(server, facade, false);
  resources.registerHandlers();
  const client: Client = new Client({ name: "resource-mutation-test", version: "1.0.0" });
  const [clientTransport, serverTransport]: [InMemoryTransport, InMemoryTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { barriers, client, resources, server, store };
}

async function close(fixture: Fixture, requests: readonly Promise<unknown>[]): Promise<void> {
  fixture.barriers.agentRelease.resolve();
  fixture.barriers.watchRelease.resolve();
  await Promise.all(requests);
  await fixture.resources.close();
  await fixture.client.close();
  await fixture.server.close();
  fixture.store.close();
}

function observed(request: Promise<unknown>): Promise<unknown> {
  return request.catch((error: unknown): unknown => error);
}

async function drainProtocol(client: Client): Promise<void> {
  // Round trips let already-sent requests and cancellation notifications reach their handlers.
  await client.ping();
  await client.ping();
}

test("canceled SDK resource mutations do not remain queued behind blocked storage", async (): Promise<void> => {
  const fixture: Fixture = await connect();
  const requests: Promise<unknown>[] = [];
  try {
    const first: Promise<unknown> = observed(fixture.client.subscribeResource({ uri: URI }));
    requests.push(first);
    await fixture.barriers.agentEntered.promise;
    for (let index: number = 0; index < 32; index += 1) {
      const cancellation: AbortController = new AbortController();
      const canceled: Promise<unknown> = observed(
        fixture.client.subscribeResource({ uri: URI }, { signal: cancellation.signal }),
      );
      requests.push(canceled);
      await drainProtocol(fixture.client);
      cancellation.abort();
      await canceled;
      await drainProtocol(fixture.client);
    }
    expect(fixture.barriers.agentCalls).toBe(1);
    const tail: Promise<unknown> = observed(fixture.client.unsubscribeResource({ uri: URI }));
    requests.push(tail);
    fixture.barriers.agentRelease.resolve();
    expect(await first).toEqual({});
    expect(await tail).toEqual({});
    expect(fixture.barriers.agentCalls).toBe(1);
    expect(fixture.barriers.watchCalls).toBe(1);
    expect(fixture.barriers.activeWatchers).toBe(0);
  } finally {
    await close(fixture, requests);
  }
});

test("a resource session rejects the seventeenth outstanding mutation before storage resumes", async (): Promise<void> => {
  const fixture: Fixture = await connect();
  const requests: Promise<unknown>[] = [];
  try {
    requests.push(observed(fixture.client.subscribeResource({ uri: URI })));
    await fixture.barriers.agentEntered.promise;
    for (let index: number = 1; index < 16; index += 1) {
      requests.push(observed(fixture.client.unsubscribeResource({ uri: URI })));
    }
    let overflowSettled: boolean = false;
    let overflowResult: unknown;
    const overflow: Promise<unknown> = observed(
      fixture.client.subscribeResource({ uri: URI }),
    ).then((result: unknown): unknown => {
      overflowSettled = true;
      overflowResult = result;
      return result;
    });
    requests.push(overflow);
    await drainProtocol(fixture.client);
    expect(overflowSettled).toBe(true);
    expect(overflowResult).toBeInstanceOf(McpError);
    if (!(overflowResult instanceof McpError)) throw new Error("Expected mutation saturation");
    expect(overflowResult.code).toBe(ErrorCode.InvalidRequest);
    expect(overflowResult.message).toContain("Inbox mutation capacity reached (16 per session).");
    expect(overflowResult.message).not.toContain("test:reader");
    expect(fixture.barriers.agentCalls).toBe(1);
    fixture.barriers.agentRelease.resolve();
    await Promise.all(requests);
    expect(await fixture.client.subscribeResource({ uri: URI })).toEqual({});
    expect(fixture.barriers.activeWatchers).toBe(1);
  } finally {
    await close(fixture, requests);
  }
});

test("canceling active setup closes a late watcher before installing a subscription", async (): Promise<void> => {
  const fixture: Fixture = await connect();
  fixture.barriers.holdAgent = false;
  fixture.barriers.holdWatch = true;
  const requests: Promise<unknown>[] = [];
  try {
    const cancellation: AbortController = new AbortController();
    const first: Promise<unknown> = observed(
      fixture.client.subscribeResource({ uri: URI }, { signal: cancellation.signal }),
    );
    requests.push(first);
    await fixture.barriers.watchEntered.promise;
    cancellation.abort();
    await first;
    await drainProtocol(fixture.client);
    const tail: Promise<unknown> = observed(
      fixture.client.unsubscribeResource({ uri: "murmur://inbox/test%3Aunrelated" }),
    );
    requests.push(tail);
    fixture.barriers.watchRelease.resolve();
    expect(await tail).toEqual({});
    expect(fixture.barriers.activeWatchers).toBe(0);
    expect(fixture.barriers.closedWatchers).toBe(1);
  } finally {
    await close(fixture, requests);
  }
});

test("canceling queued unsubscribe leaves the existing subscription usable", async (): Promise<void> => {
  const fixture: Fixture = await connect();
  const requests: Promise<unknown>[] = [];
  try {
    const first: Promise<unknown> = observed(fixture.client.subscribeResource({ uri: URI }));
    requests.push(first);
    await fixture.barriers.agentEntered.promise;
    const cancellation: AbortController = new AbortController();
    const canceled: Promise<unknown> = observed(
      fixture.client.unsubscribeResource({ uri: URI }, { signal: cancellation.signal }),
    );
    requests.push(canceled);
    await drainProtocol(fixture.client);
    cancellation.abort();
    await canceled;
    await drainProtocol(fixture.client);
    const tail: Promise<unknown> = observed(
      fixture.client.unsubscribeResource({ uri: "murmur://inbox/test%3Aunrelated" }),
    );
    requests.push(tail);
    fixture.barriers.agentRelease.resolve();
    await first;
    expect(await tail).toEqual({});
    expect(fixture.barriers.activeWatchers).toBe(1);
    expect(fixture.barriers.closedWatchers).toBe(0);
  } finally {
    await close(fixture, requests);
  }
});

test("canceling active agent lookup prevents subsequent watcher allocation", async (): Promise<void> => {
  const fixture: Fixture = await connect();
  const requests: Promise<unknown>[] = [];
  try {
    const cancellation: AbortController = new AbortController();
    const first: Promise<unknown> = observed(
      fixture.client.subscribeResource({ uri: URI }, { signal: cancellation.signal }),
    );
    requests.push(first);
    await fixture.barriers.agentEntered.promise;
    cancellation.abort();
    await first;
    await drainProtocol(fixture.client);
    const tail: Promise<unknown> = observed(
      fixture.client.unsubscribeResource({ uri: "murmur://inbox/test%3Aunrelated" }),
    );
    requests.push(tail);
    fixture.barriers.agentRelease.resolve();
    expect(await tail).toEqual({});
    expect(fixture.barriers.watchCalls).toBe(0);
  } finally {
    await close(fixture, requests);
  }
});

test("session closure rejects queued requests and cleans up a late active watcher", async (): Promise<void> => {
  const fixture: Fixture = await connect();
  fixture.barriers.holdAgent = false;
  fixture.barriers.holdWatch = true;
  const requests: Promise<unknown>[] = [];
  try {
    requests.push(observed(fixture.client.subscribeResource({ uri: URI })));
    await fixture.barriers.watchEntered.promise;
    const queued: Promise<unknown> = observed(fixture.client.subscribeResource({ uri: URI }));
    requests.push(queued);
    await drainProtocol(fixture.client);
    const closing: Promise<void> = fixture.resources.close();
    expect(await queued).toBeInstanceOf(McpError);
    expect(fixture.barriers.watchCalls).toBe(1);
    fixture.barriers.watchRelease.resolve();
    await closing;
    expect(fixture.barriers.activeWatchers).toBe(0);
    expect(fixture.barriers.closedWatchers).toBe(1);
  } finally {
    await close(fixture, requests);
  }
});
