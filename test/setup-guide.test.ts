import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PersonalId } from "../src/domain/orchestration.js";
import { AgentId, MachineName, RepositoryName, TenantId } from "../src/domain/value-objects.js";
import type { HostedPrincipal, TenantPrincipal } from "../src/hosted/control-plane.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import {
  callSetupGuideTool,
  type SetupGuideOutput,
  SetupGuideOutputSchema,
  setupGuideToolDefinition,
} from "../src/mcp/murmur-setup-guide.js";

test("a newly connected MCP client can retrieve complete setup without filesystem or repository access", async (): Promise<void> => {
  const application: MurmurApplication = new MurmurApplication({
    branchName: null,
    client: null,
    repositoryName: null,
    store: null,
  });
  const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
  const client: Client = new Client(
    { name: "setup-guide-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await application.server.connect(transports[1]);
    await client.connect(transports[0]);
    const tools: Tool[] = (await client.listTools()).tools;
    const result: CallToolResult = CallToolResultSchema.parse(
      await client.callTool({
        name: "get_setup_guide",
        arguments: {},
      }),
    );
    expect(result.isError).not.toBe(true);
    const guide: SetupGuideOutput = SetupGuideOutputSchema.parse(result.structuredContent);
    expect(guide.available_tools).toEqual(tools.map((tool: Tool): string => tool.name).sort());
    expect(guide.available_tools).not.toContain("create_orchestrator_token");
    expect(guide.sections).toHaveLength(7);
    const text: string = guide.sections
      .map((section: SetupGuideOutput["sections"][number]): string => section.instructions)
      .join("\n");
    expect(text).toContain("https://api.usemurmur.dev/downloads/murmur.tgz");
    expect(text).not.toContain("git+https://");
    expect(text).toContain("murmur setup --user");
    expect(text).toContain("fx mcp add --transport http murmur");
    expect(text).toContain("~/.fx/mcp.json");
    expect(text).toContain("managed ~/.fx/AGENTS.md block");
    expect(text).toContain("current-checkout context contract");
    expect(text).toContain("SessionEnd");
    expect(text).toContain("AGENTS.override.md");
    expect(text).toContain("create_access_token");
    expect(text).toContain("transition_e2ee");
    expect(text).toContain("set_orchestrator_policy");
    expect(text).toContain("personal+machine+repository");
    expect(text).toContain('"machine":"build-1"');
    expect(text).toContain('"scope_kind":"organization","repository":"owner/repository"');
    expect(text).toContain(
      '"scope_kind":"personal","personal_id":"<worker personal_id>","machine":"build-1"',
    );
    expect(text).toContain("not hardware attestation");
    expect(text).toContain("Repository or hosted-service ownership is not Murmur tenant authority");
    expect(text).toContain("mint_tenant_admin_token");
    expect(text).toContain("set-orchestrator-policy-mutations.sh freeze");
    expect(text).toContain("restores and verifies SELECT, INSERT, and UPDATE");
    expect(text).toContain("/v1/tenants");
    expect(text).toContain("user-controlled");
    expect(text).toContain("MURMUR_API_TOKEN");
    expect(client.getInstructions()).toContain("get_setup_guide");
    const instructions: string | undefined = client.getInstructions();
    if (instructions === undefined) throw new Error("Murmur server instructions were omitted");
    expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(2048);
    const invalid: CallToolResult = CallToolResultSchema.parse(
      await client.callTool({
        name: "get_setup_guide",
        arguments: { topic: "hooks", tenant_id: "attacker" },
      }),
    );
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await application.close();
  }
});

test("every authenticated tenant role gets the complete guide on normal MCP with role-specific tools", async (): Promise<void> => {
  const tenantId: TenantId = TenantId.parse("00000000-0000-4000-8000-000000000001");
  const personalId: PersonalId = PersonalId.parse("20000000-0000-4000-8000-000000000001");
  const principals: readonly TenantPrincipal[] = [
    {
      kind: "tenant",
      machineName: MachineName.parse("build-machine-1"),
      personalId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      role: "agent",
      tenantId,
      tokenId: "10000000-0000-4000-8000-000000000001",
    },
    {
      kind: "tenant",
      machineName: MachineName.parse("build-machine-1"),
      personalId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      role: "tenant_admin",
      tenantId,
      tokenId: "10000000-0000-4000-8000-000000000002",
    },
    {
      agentId: AgentId.parse("build-machine-1-orchestrator"),
      kind: "tenant",
      machineName: MachineName.parse("build-machine-1"),
      personalId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      role: "orchestrator",
      tenantId,
      tokenId: "10000000-0000-4000-8000-000000000003",
    },
  ];
  for (const principal of principals) {
    const application: MurmurApplication = new MurmurApplication({
      branchName: null,
      client: null,
      orchestrationEnabled: true,
      principal,
      repositoryName: null,
      store: null,
    });
    const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
    const client: Client = new Client(
      { name: `authenticated-${principal.role}-guide-test`, version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await application.server.connect(transports[1]);
      await client.connect(transports[0]);
      const tools: Tool[] = (await client.listTools()).tools;
      const guide: SetupGuideOutput = SetupGuideOutputSchema.parse(
        (
          await client.callTool(
            { name: "get_setup_guide", arguments: { topic: "all" } },
            CallToolResultSchema,
          )
        ).structuredContent,
      );
      expect(guide.sections).toHaveLength(7);
      expect(guide.available_tools).toEqual(tools.map((tool: Tool): string => tool.name).sort());
      expect(guide.available_tools).toContain("get_setup_guide");
      const instructions: string | undefined = client.getInstructions();
      if (instructions === undefined) throw new Error("Murmur server instructions were omitted");
      expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(2048);
      if (principal.role === "agent") expect(guide.available_tools).toContain("ask_orchestrator");
      if (principal.role === "tenant_admin") {
        expect(guide.available_tools).toContain("create_orchestrator_token");
        expect(guide.available_tools).toContain("set_orchestrator_policy");
      }
      if (principal.role === "orchestrator") {
        expect(guide.available_tools).toContain("get_delegation");
      }
    } finally {
      await client.close();
      await application.close();
    }
  }
});

test("bootstrap and operator sessions get the complete guide on normal MCP", async (): Promise<void> => {
  const principals: readonly { readonly label: string; readonly principal: HostedPrincipal }[] = [
    {
      label: "bootstrap",
      principal: {
        keyId: "bootstrap-key",
        kind: "bootstrap",
        tokenId: "10000000-0000-4000-8000-000000000004",
      },
    },
    {
      label: "operator",
      principal: {
        credentialHash: Buffer.alloc(32, 7),
        keyId: "operator-key",
        kind: "operator",
        tokenId: "10000000-0000-4000-8000-000000000005",
      },
    },
  ];
  for (const entry of principals) {
    const application: MurmurApplication = new MurmurApplication({
      bootstrapCredentialHash: Buffer.alloc(32, 3),
      branchName: null,
      client: null,
      orchestrationEnabled: true,
      principal: entry.principal,
      repositoryName: null,
      store: null,
      tenantOnboardingEnabled: true,
    });
    const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
    const client: Client = new Client(
      { name: `${entry.label}-guide-test`, version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await application.server.connect(transports[1]);
      await client.connect(transports[0]);
      const tools: Tool[] = (await client.listTools()).tools;
      const guide: SetupGuideOutput = SetupGuideOutputSchema.parse(
        (
          await client.callTool(
            { name: "get_setup_guide", arguments: { topic: "all" } },
            CallToolResultSchema,
          )
        ).structuredContent,
      );
      expect(guide.available_tools).toEqual(tools.map((tool: Tool): string => tool.name).sort());
      expect(guide.available_tools).toContain("get_setup_guide");
      if (entry.principal.kind === "bootstrap") {
        expect(guide.available_tools).toContain("bootstrap_operator");
      } else {
        expect(guide.available_tools).toContain("create_tenant");
      }
    } finally {
      await client.close();
      await application.close();
    }
  }
});

test("guide topics are bounded and cannot mutate capability exposure", (): void => {
  const tool: Tool = setupGuideToolDefinition();
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  const result: CallToolResult | null = callSetupGuideTool(
    "get_setup_guide",
    { topic: "encryption" },
    [tool],
  );
  if (result === null) throw new Error("Setup guide missing");
  const guide: SetupGuideOutput = SetupGuideOutputSchema.parse(result.structuredContent);
  expect(guide.sections).toHaveLength(1);
  expect(guide.sections[0]).toMatchObject({ topic: "encryption" });
  expect(guide.available_tools).toEqual(["get_setup_guide"]);
  expect(callSetupGuideTool("unrelated", {}, [tool])).toBeNull();
  expect(callSetupGuideTool("get_setup_guide", undefined, [tool])).not.toBeNull();
  expect((): unknown =>
    callSetupGuideTool("get_setup_guide", { topic: "arbitrary-file" }, [tool]),
  ).toThrow();
  expect((): unknown => callSetupGuideTool("get_setup_guide", null, [tool])).toThrow();
});
