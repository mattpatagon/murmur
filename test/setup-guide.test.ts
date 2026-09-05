import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import {
  callSetupGuideTool,
  setupGuideToolDefinition,
  SetupGuideOutputSchema,
  type SetupGuideOutput,
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
    expect(text).toContain("SessionEnd");
    expect(text).toContain("AGENTS.override.md");
    expect(text).toContain("create_access_token");
    expect(text).toContain("transition_e2ee");
    expect(text).toContain("set_orchestrator_policy");
    expect(text).toContain("/v1/tenants");
    expect(text).toContain("user-controlled");
    expect(text).toContain("MURMUR_API_TOKEN");
    expect(client.getInstructions()).toContain("get_setup_guide");
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
