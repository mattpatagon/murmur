import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { AgentClient, BranchName, RepositoryName, TenantId } from "../src/domain/value-objects.js";
import { parseE2eeEntitlementRecord } from "../src/hosted/e2ee-entitlement.js";
import type { HostedPrincipal } from "../src/hosted/control-plane.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

test("enforced applications reject hidden plaintext calls and expose no plaintext resources", async (): Promise<void> => {
  const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
  const tenantId: TenantId = TenantId.founding();
  const principal: HostedPrincipal = {
    kind: "tenant",
    role: "agent",
    tenantId,
    tokenId: "10000000-0000-4000-8000-000000000010",
  };
  const application: MurmurApplication = new MurmurApplication({
    branchName: BranchName.parse("feature/e2ee"),
    client: AgentClient.parse("codex"),
    e2eeCapability: {
      max_ciphertext_bytes: 524_304,
      max_one_time_prekeys: 20,
      protocol: "murmur-e2ee-v1",
      state: "enforced",
      tenant_id: tenantId.value,
      wire_version: 1,
    },
    e2eeEntitlement: parseE2eeEntitlementRecord({
      plaintextWritesBlocked: true,
      retainedCiphertextMessages: 0,
      state: "enforced",
      trustPolicyVersion: 1,
      unreadPlaintextMessages: 0,
    }),
    e2eeStore: null,
    principal,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    store: new SqliteMessageStore(":memory:"),
  });
  const client: Client = new Client(
    { name: "e2ee-enforcement-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await application.server.connect(transports[1]);
    await client.connect(transports[0]);
    const listed: ListToolsResult = await client.listTools();
    const names: readonly string[] = listed.tools.map(
      (tool: ListToolsResult["tools"][number]): string => tool.name,
    );
    expect(names).toContain("get_encrypted_messages");
    expect(names).not.toContain("get_messages");
    expect(names).not.toContain("send_message");
    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);

    const raw: unknown = await client.callTool({
      arguments: { content: "must never route", recipient_id: "bob", sender_id: "alice" },
      name: "send_message",
    });
    const hidden: CallToolResult = CallToolResultSchema.parse(raw);
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden)).toContain("Unknown tool");

    const capabilityRaw: unknown = await client.callTool({
      arguments: {},
      name: "get_e2ee_capability",
    });
    const capability: CallToolResult = CallToolResultSchema.parse(capabilityRaw);
    expect(capability.structuredContent).toMatchObject({ state: "enforced" });
  } finally {
    await client.close();
    await application.close();
  }
});
