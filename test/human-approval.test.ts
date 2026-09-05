import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { approveExactRequest } from "../src/admin/approval-request.js";
import {
  answerAdminApproval,
  parseAdminArguments,
  runAdminCli,
} from "../src/admin/terminal-client.js";
import { TenantId } from "../src/domain/value-objects.js";
import type { TenantPrincipal } from "../src/hosted/control-plane.js";
import { MurmurHumanApproval } from "../src/mcp/human-approval.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { toolError, toolResult } from "../src/mcp/murmur-tool-results.js";

const INPUT: Record<string, unknown> = { agent_id: "approved-boss", name: "Delegated coordinator" };
const PRINCIPAL: TenantPrincipal = {
  kind: "tenant",
  role: "tenant_admin",
  tenantId: TenantId.parse("00000000-0000-4000-8000-000000000001"),
  tokenId: "10000000-0000-4000-8000-000000000001",
};

type Harness = {
  readonly call: (
    name?: string,
    input?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<CallToolResult>;
  readonly close: () => Promise<void>;
  readonly changes: unknown[];
};

async function harness(
  answer: ((request: ElicitRequest) => Promise<ElicitResult>) | null,
  revalidate: () => Promise<boolean> = async (): Promise<boolean> => true,
): Promise<Harness> {
  const server: Server = new Server(
    { name: "approval-server", version: "1" },
    { capabilities: { tools: {} } },
  );
  const approval: MurmurHumanApproval = new MurmurHumanApproval(server);
  const changes: unknown[] = [];
  server.setRequestHandler(
    CallToolRequestSchema,
    async (
      request: CallToolRequest,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ): Promise<CallToolResult> => {
      try {
        const input: unknown = await approval.approve(
          request.params.name,
          request.params.arguments,
          PRINCIPAL,
          {
            relatedRequestId: extra.requestId,
            signal: extra.signal,
          },
          revalidate,
        );
        changes.push(input);
        return toolResult({ changed: true });
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );
  const client: Client = new Client(
    { name: "trusted-test-host", version: "1" },
    {
      capabilities: answer === null ? {} : { elicitation: { form: {} } },
    },
  );
  if (answer !== null) client.setRequestHandler(ElicitRequestSchema, answer);
  const [serverTransport, clientTransport]: [InMemoryTransport, InMemoryTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: async (
      name: string = "create_orchestrator_token",
      input: Record<string, unknown> = INPUT,
      signal?: AbortSignal,
    ): Promise<CallToolResult> =>
      CallToolResultSchema.parse(
        await client.callTool(
          { name, arguments: input },
          CallToolResultSchema,
          signal === undefined ? {} : { signal },
        ),
      ),
    changes,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

test("admin cannot grant orchestrator authority without a host that collects human approval", async (): Promise<void> => {
  const context: Harness = await harness(null);
  try {
    expect((await context.call()).isError).toBe(true);
    expect(context.changes).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("exact human-approved grants include full payload and authenticated tenant", async (): Promise<void> => {
  const context: Harness = await harness(async (request: ElicitRequest): Promise<ElicitResult> => {
    expect(request.params.message).toContain(PRINCIPAL.tenantId.value);
    expect(request.params.message).toContain("approved-boss");
    return approveExactRequest(request, "create_orchestrator_token", INPUT);
  });
  try {
    expect((await context.call()).isError).not.toBe(true);
    expect(context.changes).toEqual([INPUT]);
  } finally {
    await context.close();
  }
});

test("decline, cancel, empty accept, forged boolean, and replayed confirmation cannot mutate", async (): Promise<void> => {
  let prior: ElicitResult = { action: "decline" };
  const first: Harness = await harness(async (request: ElicitRequest): Promise<ElicitResult> => {
    prior = approveExactRequest(request, "create_orchestrator_token", INPUT);
    return prior;
  });
  try {
    await first.call();
  } finally {
    await first.close();
  }
  for (const answer of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept" },
    { action: "accept", content: { approved: true } },
    prior,
  ]) {
    const context: Harness = await harness(async (): Promise<ElicitResult> => {
      if (answer.action === "accept") return { action: "accept", content: answer.content };
      return answer.action === "cancel" ? { action: "cancel" } : { action: "decline" };
    });
    try {
      expect((await context.call()).isError).toBe(true);
      expect(context.changes).toHaveLength(0);
    } finally {
      await context.close();
    }
  }
});

test("preapproved automation is limited to the exact operation and values", async (): Promise<void> => {
  const context: Harness = await harness(async (request: ElicitRequest): Promise<ElicitResult> => {
    expect(approveExactRequest(request, "create_access_token", INPUT).action).toBe("decline");
    expect(
      approveExactRequest(request, "create_orchestrator_token", { ...INPUT, agent_id: "attacker" })
        .action,
    ).toBe("decline");
    return { action: "decline" };
  });
  try {
    await context.call();
    expect(context.changes).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("role elevation, delegation, tenant control, encryption and revocation all require approval", async (): Promise<void> => {
  const inputs: ReadonlyMap<string, Record<string, unknown>> = new Map<
    string,
    Record<string, unknown>
  >([
    ["create_access_token", { name: "New administrator", role: "tenant_admin" }],
    [
      "set_orchestrator_policy",
      { scope_kind: "organization", orchestrator_key_id: "key00001", instructions: "Coordinate" },
    ],
    ["clear_orchestrator_policy", { scope_kind: "organization" }],
    ["mint_tenant_admin_token", { name: "Recovery", tenant_id: PRINCIPAL.tenantId.value }],
    ["create_operator_token", { name: "Recovery operator" }],
    ["create_tenant", { slug: "new-tenant", display_name: "New organization" }],
    ["suspend_tenant", { tenant_id: PRINCIPAL.tenantId.value }],
    ["restore_tenant", { tenant_id: PRINCIPAL.tenantId.value }],
    ["revoke_access_token", { key_id: "key00001" }],
    ["revoke_operator_token", { key_id: "key00001" }],
    ["transition_e2ee", { action: "begin_provisioning", expected_state: "off" }],
    ["adopt_legacy_founding_token", {}],
  ]);
  const context: Harness = await harness(null);
  try {
    for (const [name, input] of inputs)
      expect((await context.call(name, input)).isError).toBe(true);
    expect(context.changes).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("revocation during human approval blocks an accepted mutation", async (): Promise<void> => {
  const context: Harness = await harness(
    async (request: ElicitRequest): Promise<ElicitResult> =>
      approveExactRequest(request, "create_orchestrator_token", INPUT),
    async (): Promise<boolean> => false,
  );
  try {
    expect(JSON.stringify(await context.call())).toContain("Authorization changed");
    expect(context.changes).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("host failures remain private and release the pending approval slot", async (): Promise<void> => {
  const context: Harness = await harness(async (): Promise<ElicitResult> => {
    throw new Error("private host exception with hidden token material");
  });
  try {
    const failed: string = JSON.stringify(await context.call());
    expect(failed).toContain("interrupted, unavailable, or expired");
    expect(failed).not.toContain("private host exception");
    expect(JSON.stringify(await context.call())).not.toContain("already pending");
    expect(context.changes).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("request cancellation cannot become consent and read-only operations remain available", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  let release: () => void = (): void => undefined;
  const pending: Promise<void> = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  const context: Harness = await harness(async (request: ElicitRequest): Promise<ElicitResult> => {
    controller.abort();
    await pending;
    return approveExactRequest(request, "create_orchestrator_token", INPUT);
  });
  try {
    await expect(
      context.call("create_orchestrator_token", INPUT, controller.signal),
    ).rejects.toThrow();
    expect(context.changes).toHaveLength(0);
  } finally {
    release();
    await context.close();
  }
  const reader: Harness = await harness(null);
  try {
    expect((await reader.call("get_orchestrator", {})).isError).not.toBe(true);
  } finally {
    await reader.close();
  }
});

test("invalid arguments do not prompt and a single session cannot accumulate approval requests", async (): Promise<void> => {
  let prompted: () => void = (): void => undefined;
  const received: Promise<void> = new Promise<void>((resolve: () => void): void => {
    prompted = resolve;
  });
  let release: () => void = (): void => undefined;
  const decision: Promise<void> = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  const context: Harness = await harness(async (): Promise<ElicitResult> => {
    prompted();
    await decision;
    return { action: "cancel" };
  });
  try {
    expect(
      (await context.call("create_orchestrator_token", { ...INPUT, approved: true })).isError,
    ).toBe(true);
    const first: Promise<CallToolResult> = context.call();
    await received;
    expect(JSON.stringify(await context.call())).toContain("already pending");
    release();
    await first;
    expect(context.changes).toHaveLength(0);
  } finally {
    release();
    await context.close();
  }
});

test("the actual MCP application gates administrative dispatch", async (): Promise<void> => {
  const application: MurmurApplication = new MurmurApplication({
    branchName: null,
    client: null,
    principal: PRINCIPAL,
    repositoryName: null,
    store: null,
    orchestrationEnabled: true,
  });
  const client: Client = new Client({ name: "no-user-approval", version: "1" });
  const [serverTransport, clientTransport]: [InMemoryTransport, InMemoryTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result: unknown = await client.callTool({
      name: "create_orchestrator_token",
      arguments: INPUT,
    });
    expect(JSON.stringify(result)).toContain("Human approval requires");
  } finally {
    await client.close();
    await application.close();
  }
});

test("terminal admin rejects automated approval and unsafe endpoints", async (): Promise<void> => {
  await expect(runAdminCli(["tools"])).rejects.toThrow("interactive terminal");
  expect((): unknown =>
    parseAdminArguments(["tools", "--url", "http://example.org/mcp"]),
  ).toThrow();
  expect((): unknown =>
    parseAdminArguments(["tools", "--url", "https://secret@example.org/mcp"]),
  ).toThrow();
  expect((): unknown => parseAdminArguments(["tools", "--yes"])).toThrow();
  expect(parseAdminArguments(["tools", "--url", "http://localhost/mcp"]).url.hostname).toBe(
    "localhost",
  );
});

test("terminal approval needs an explicit human decision and submits only current confirmation", async (): Promise<void> => {
  const request: ElicitRequest = {
    method: "elicitation/create",
    params: {
      message: "Review exact grant",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          confirmation: { type: "string", enum: ["approve:00000000-0000-4000-8000-000000000001"] },
        },
        required: ["confirmation"],
      },
    },
  };
  expect((await answerAdminApproval(request, async (): Promise<boolean> => false)).action).toBe(
    "decline",
  );
  expect((await answerAdminApproval(request, async (): Promise<boolean> => true)).action).toBe(
    "accept",
  );
});
