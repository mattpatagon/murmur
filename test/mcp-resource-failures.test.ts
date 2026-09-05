import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { RegisterAgentOutputSchema } from "../src/domain/contracts.js";
import type {
  Agent,
  GetMessagesQuery,
  ListAgentsQuery,
  ListAgentsResult,
} from "../src/domain/models.js";
import {
  AgentClient,
  type AgentId,
  BranchName,
  RepositoryName,
  type Sequence,
} from "../src/domain/value-objects.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import type {
  InboxReadResult,
  InboxSubscription,
  InboxUpdateHandler,
} from "../src/storage/message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { callValidated } from "./support/mcp-client-harness.js";

const URI: string = "murmur://inbox/test%3Areader";
const PRIVATE_DETAIL: string = "SELECT internal_table: RESOURCE_PRIVATE_SENTINEL";
type FaultMethod = "list" | "read" | "version" | "agent" | "watch" | "close";

class ResourceFaultStore extends SqliteMessageStore {
  public fault: { readonly method: FaultMethod; readonly error: unknown } | null = null;
  public faultCalls: number = 0;

  private fail(method: FaultMethod): void {
    if (this.fault !== null && this.fault.method === method) {
      this.faultCalls += 1;
      throw this.fault.error;
    }
  }

  public override listAgents(query: ListAgentsQuery): ListAgentsResult {
    this.fail("list");
    return super.listAgents(query);
  }

  public override getMessagesWithVersion(query: GetMessagesQuery): InboxReadResult {
    this.fail("read");
    this.fail("version");
    return super.getMessagesWithVersion(query);
  }

  public override getAgent(agentId: AgentId): Agent | null {
    this.fail("agent");
    return super.getAgent(agentId);
  }

  public override getInboxVersion(agentId: AgentId): Sequence {
    this.fail("version");
    return super.getInboxVersion(agentId);
  }

  public override watchInbox(
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): InboxSubscription {
    this.fail("watch");
    const subscription: InboxSubscription = super.watchInbox(agentId, afterSequence, handler);
    return {
      close: async (): Promise<void> => {
        this.fail("close");
        await subscription.close();
      },
    };
  }
}

type ResourceFixture = {
  readonly application: MurmurApplication;
  readonly client: Client;
  readonly store: ResourceFaultStore;
};

async function connect(): Promise<ResourceFixture> {
  const store: ResourceFaultStore = new ResourceFaultStore(":memory:");
  const application: MurmurApplication = new MurmurApplication({
    branchName: BranchName.parse("resource-boundary-test"),
    client: AgentClient.parse("codex"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    store,
  });
  const client: Client = new Client({ name: "resource-boundary-test", version: "1.0.0" });
  const [clientTransport, serverTransport]: [InMemoryTransport, InMemoryTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    await callValidated(
      client,
      "register_agent",
      { agent_id: "test:reader", display_name: "Reader" },
      RegisterAgentOutputSchema,
    );
    return { application, client, store };
  } catch (error: unknown) {
    await client.close();
    await application.close();
    throw error;
  }
}

async function close(fixture: ResourceFixture): Promise<void> {
  fixture.store.fault = null;
  await fixture.application.close();
  await fixture.client.close();
}

async function request(client: Client, method: FaultMethod): Promise<unknown> {
  if (method === "list") return await client.listResources();
  if (method === "read" || method === "version") return await client.readResource({ uri: URI });
  if (method === "close") return await client.unsubscribeResource({ uri: URI });
  return await client.subscribeResource({ uri: URI });
}

async function rejected(operation: Promise<unknown>): Promise<McpError> {
  const result: unknown = await operation.catch((error: unknown): unknown => error);
  expect(result).toBeInstanceOf(McpError);
  if (!(result instanceof McpError)) throw new Error("Expected a protocol failure");
  return result;
}

const METHODS: readonly FaultMethod[] = ["list", "read", "version", "agent", "watch", "close"];
for (const method of METHODS) {
  for (const code of ["22001", "ECONNRESET"]) {
    test(`resource ${method} hides ${code} storage failures at the client protocol boundary`, async (): Promise<void> => {
      const fixture: ResourceFixture = await connect();
      try {
        if (method === "close") await fixture.client.subscribeResource({ uri: URI });
        const error: Error = new Error(PRIVATE_DETAIL);
        Reflect.set(error, "code", code);
        Reflect.set(error, "data", { internal: PRIVATE_DETAIL });
        fixture.store.fault = { error, method };
        const failure: McpError = await rejected(request(fixture.client, method));
        expect(fixture.store.faultCalls).toBe(1);
        expect(failure.code).toBe(ErrorCode.InternalError);
        expect(failure.message).not.toContain("RESOURCE_PRIVATE_SENTINEL");
        expect(failure.message).toContain("Storage operation failed. Retry the request.");
        expect(failure.data).toBeUndefined();
        fixture.store.fault = null;
        await request(fixture.client, method);
      } finally {
        await close(fixture);
      }
    });
  }
}

test("resource input and missing-agent errors preserve their existing protocol contracts", async (): Promise<void> => {
  const fixture: ResourceFixture = await connect();
  try {
    for (const uri of ["unsupported://resource", "murmur://inbox/", "murmur://inbox/%ZZ"]) {
      const failure: McpError = await rejected(fixture.client.readResource({ uri }));
      expect(failure.code).toBe(ErrorCode.InvalidParams);
      expect(failure.message).toContain("resource URI");
    }
    const missing: McpError = await rejected(
      fixture.client.subscribeResource({ uri: "murmur://inbox/test%3Amissing" }),
    );
    expect(missing.code).toBe(ErrorCode.InvalidParams);
    expect(missing.message).toContain("Unknown agent 'test:missing'. Register it first.");
    fixture.store.fault = { error: new Error("Existing domain guidance"), method: "list" };
    const domain: McpError = await rejected(fixture.client.listResources());
    expect(domain.code).toBe(ErrorCode.InternalError);
    expect(domain.message).toContain("Existing domain guidance");
  } finally {
    await close(fixture);
  }
});
