import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  CloseAgentInputSchema,
  EndSessionInputSchema,
  encodeAgentCursor,
  ListAgentsInputSchema,
  ListAgentsOutputSchema,
  listAgentsQuery,
  SendMessageInputSchema,
} from "../src/domain/contracts.js";
import { SubmitFeedbackInputSchema } from "../src/domain/feedback-contracts.js";
import { PostNoticeInputSchema } from "../src/domain/notice-contracts.js";
import { PersonalId } from "../src/domain/orchestration.js";
import { AgentId, RepositoryName, TenantId } from "../src/domain/value-objects.js";
import type { HostedPrincipal } from "../src/hosted/control-plane.js";
import { parseE2eeEntitlementRecord, tenantDataToolNames } from "../src/hosted/e2ee-entitlement.js";
import { toolsForPrincipal } from "../src/mcp/murmur-tool-definitions.js";
import type { ToolExposure } from "../src/mcp/murmur-tool-exposure.js";

const DATA_TOOLS: readonly string[] = [
  "broadcast_message",
  "close_agent",
  "end_session",
  "get_agent",
  "get_message_history",
  "get_messages",
  "list_agents",
  "list_notices",
  "mark_messages_read",
  "post_notice",
  "register_agent",
  "resolve_notice",
  "send_message",
  "submit_feedback",
  "wait_for_messages",
  "withdraw_notice",
];
const UTILITY_TOOLS: readonly string[] = ["check_for_upgrades"];
const TENANT_ADMIN_TOOLS: readonly string[] = [
  "create_access_token",
  "get_e2ee_entitlement",
  "list_access_tokens",
  "reset_e2ee_identity",
  "revoke_access_token",
  "transition_e2ee",
];
const WORKER_ORCHESTRATION_TOOLS: readonly string[] = ["ask_orchestrator", "get_orchestrator"];
const ADMIN_ORCHESTRATION_TOOLS: readonly string[] = [
  "clear_orchestrator_policy",
  "create_orchestrator_token",
  "list_orchestrator_policies",
  "set_orchestrator_policy",
];
const BOSS_ORCHESTRATION_TOOLS: readonly string[] = ["get_delegation", "get_orchestrator"];
const OPERATOR_TOOLS: readonly string[] = [
  "adopt_legacy_founding_token",
  "create_operator_token",
  "create_tenant",
  "list_admin_audit",
  "list_operator_tokens",
  "list_tenants",
  "mint_tenant_admin_token",
  "restore_tenant",
  "revoke_operator_token",
  "suspend_tenant",
];

function names(exposure: ToolExposure): readonly string[] {
  return toolsForPrincipal(exposure)
    .map((tool: Tool): string => tool.name)
    .sort();
}

function exposure(principal: HostedPrincipal | null): ToolExposure {
  return {
    bootstrapEnabled: true,
    legacyAdoptionEnabled: true,
    principal,
    tenantOnboardingEnabled: true,
  };
}

describe("MCP role-to-tool exposure", (): void => {
  test("local and tenant-agent sessions expose data tools only", (): void => {
    const tenantAgent: HostedPrincipal = {
      kind: "tenant",
      role: "agent",
      tenantId: TenantId.parse("00000000-0000-4000-8000-000000000001"),
      tokenId: "10000000-0000-4000-8000-000000000001",
    };
    expect(names(exposure(null))).toEqual([...DATA_TOOLS, ...UTILITY_TOOLS].sort());
    expect(names(exposure(tenantAgent))).toEqual([...DATA_TOOLS, ...UTILITY_TOOLS].sort());
  });

  test("tenant administrators add only tenant lifecycle tools", (): void => {
    const principal: HostedPrincipal = {
      kind: "tenant",
      role: "tenant_admin",
      tenantId: TenantId.parse("00000000-0000-4000-8000-000000000001"),
      tokenId: "10000000-0000-4000-8000-000000000002",
    };
    expect(names(exposure(principal))).toEqual(
      [...DATA_TOOLS, ...TENANT_ADMIN_TOOLS, ...UTILITY_TOOLS].sort(),
    );
  });

  test("tenant E2E enforcement exposes ciphertext tools and blocks every plaintext route", (): void => {
    const principal: HostedPrincipal = {
      kind: "tenant",
      role: "agent",
      tenantId: TenantId.parse("00000000-0000-4000-8000-000000000001"),
      tokenId: "10000000-0000-4000-8000-000000000009",
    };
    const entitlement: ReturnType<typeof parseE2eeEntitlementRecord> = parseE2eeEntitlementRecord({
      plaintextWritesBlocked: true,
      retainedCiphertextMessages: 0,
      state: "enforced",
      trustPolicyVersion: 1,
      unprovisionedActiveAgents: 0,
      unreadPlaintextMessages: 0,
    });
    expect(names({ ...exposure(principal), e2eeEntitlement: entitlement })).toEqual(
      [
        ...tenantDataToolNames(entitlement).filter(
          (name: string): boolean => name !== "claim_orchestrator_prekey",
        ),
        ...UTILITY_TOOLS,
      ].sort(),
    );
    expect(names({ ...exposure(principal), e2eeEntitlement: entitlement })).not.toContain(
      "get_messages",
    );
    expect(names({ ...exposure(principal), e2eeEntitlement: entitlement })).toContain(
      "get_encrypted_messages",
    );
  });

  test("strict multi-tenant sessions expose orchestration tools by authenticated role", (): void => {
    const personalId: PersonalId = PersonalId.parse("20000000-0000-4000-8000-000000000001");
    const tenantId: TenantId = TenantId.parse("00000000-0000-4000-8000-000000000001");
    const agent: HostedPrincipal = {
      kind: "tenant",
      personalId,
      repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      role: "agent",
      tenantId,
      tokenId: "10000000-0000-4000-8000-000000000006",
    };
    const admin: HostedPrincipal = {
      ...agent,
      role: "tenant_admin",
      tokenId: "10000000-0000-4000-8000-000000000007",
    };
    const boss: HostedPrincipal = {
      ...agent,
      agentId: AgentId.parse("boss-agent"),
      role: "orchestrator",
      tokenId: "10000000-0000-4000-8000-000000000008",
    };
    expect(names({ ...exposure(agent), orchestrationEnabled: true })).toEqual(
      [...DATA_TOOLS, ...WORKER_ORCHESTRATION_TOOLS, ...UTILITY_TOOLS].sort(),
    );
    expect(names({ ...exposure(admin), orchestrationEnabled: true })).toEqual(
      [
        ...DATA_TOOLS,
        ...WORKER_ORCHESTRATION_TOOLS,
        ...TENANT_ADMIN_TOOLS,
        ...ADMIN_ORCHESTRATION_TOOLS,
        ...UTILITY_TOOLS,
      ].sort(),
    );
    expect(names({ ...exposure(boss), orchestrationEnabled: true })).toEqual(
      [...DATA_TOOLS, ...BOSS_ORCHESTRATION_TOOLS, ...UTILITY_TOOLS].sort(),
    );
    expect(names(exposure(boss))).toEqual(UTILITY_TOOLS);
  });

  test("enforced E2E uses only encrypted orchestration content routes", (): void => {
    const tenantId: TenantId = TenantId.parse("00000000-0000-4000-8000-000000000001");
    const entitlement: ReturnType<typeof parseE2eeEntitlementRecord> = parseE2eeEntitlementRecord({
      plaintextWritesBlocked: true,
      retainedCiphertextMessages: 0,
      state: "enforced",
      trustPolicyVersion: 1,
      unprovisionedActiveAgents: 0,
      unreadPlaintextMessages: 0,
    });
    const worker: HostedPrincipal = {
      kind: "tenant",
      personalId: PersonalId.parse("20000000-0000-4000-8000-000000000001"),
      role: "agent",
      tenantId,
      tokenId: "10000000-0000-4000-8000-000000000011",
    };
    const boss: HostedPrincipal = {
      ...worker,
      agentId: AgentId.parse("boss-agent"),
      role: "orchestrator",
      tokenId: "10000000-0000-4000-8000-000000000012",
    };
    const workerTools: readonly string[] = names({
      ...exposure(worker),
      e2eeEntitlement: entitlement,
      orchestrationEnabled: true,
    });
    expect(workerTools).toContain("claim_orchestrator_prekey");
    expect(workerTools).toContain("get_orchestrator");
    expect(workerTools).not.toContain("ask_orchestrator");
    expect(workerTools).not.toContain("send_message");
    const bossTools: readonly string[] = names({
      ...exposure(boss),
      e2eeEntitlement: entitlement,
      orchestrationEnabled: true,
    });
    expect(bossTools).toContain("get_delegation");
    expect(bossTools).toContain("claim_encryption_prekey");
    expect(bossTools).not.toContain("claim_orchestrator_prekey");
  });

  test("bootstrap sessions keep the upgrade utility outside the bootstrap proof gate", (): void => {
    const principal: HostedPrincipal = {
      keyId: "bootstrap",
      kind: "bootstrap",
      tokenId: "10000000-0000-4000-8000-000000000003",
    };
    expect(names(exposure(principal))).toEqual(["bootstrap_operator", ...UTILITY_TOOLS].sort());
    expect(names({ ...exposure(principal), bootstrapEnabled: false })).toEqual(UTILITY_TOOLS);
  });

  test("operator sessions expose no tenant data tools and honor rollout gates", (): void => {
    const principal: HostedPrincipal = {
      credentialHash: Buffer.alloc(32, 7),
      keyId: "operator",
      kind: "operator",
      tokenId: "10000000-0000-4000-8000-000000000004",
    };
    expect(names(exposure(principal))).toEqual([...OPERATOR_TOOLS, ...UTILITY_TOOLS].sort());
    expect(
      names({
        ...exposure(principal),
        legacyAdoptionEnabled: false,
        tenantOnboardingEnabled: false,
      }),
    ).toEqual(
      [
        ...OPERATOR_TOOLS.filter(
          (name: string): boolean =>
            name !== "adopt_legacy_founding_token" && name !== "create_tenant",
        ),
        ...UTILITY_TOOLS,
      ].sort(),
    );
    expect(names(exposure(principal))).not.toContain("register_agent");
  });

  test("every exposed tool name is unique and carries validated schemas", (): void => {
    const principal: HostedPrincipal = {
      credentialHash: Buffer.alloc(32, 8),
      keyId: "operator",
      kind: "operator",
      tokenId: "10000000-0000-4000-8000-000000000005",
    };
    const tools: Tool[] = toolsForPrincipal(exposure(principal));
    expect(new Set(tools.map((tool: Tool): string => tool.name)).size).toBe(tools.length);
    tools.forEach((tool: Tool): void => {
      expect(tool.inputSchema.type).toBe("object");
      if (tool.outputSchema === undefined) throw new Error(`${tool.name} has no output schema`);
      expect(tool.outputSchema.type).toBe("object");
    });
  });

  test("lifecycle guards and shared value schemas match the runtime contract", (): void => {
    expect(EndSessionInputSchema.safeParse({ agent_id: "agent-a", reason: "stop" }).success).toBe(
      false,
    );
    expect(CloseAgentInputSchema.safeParse({ agent_id: "agent-a", reason: "manual" }).success).toBe(
      false,
    );
    expect(
      SendMessageInputSchema.safeParse({
        content: "hello",
        recipient_id: "agent-b",
        sender_id: "agent-a",
        session_key: "invalid session key",
      }).success,
    ).toBe(false);
    expect(
      PostNoticeInputSchema.safeParse({
        actor_id: "agent-a",
        content: "handoff",
        kind: "handoff",
        repository: "not-a-repository",
      }).success,
    ).toBe(false);
    expect(
      SubmitFeedbackInputSchema.parse({
        description: "  Explain the problem  ",
        reporter_id: "agent-a",
        title: "  Better diagnostics  ",
        type: "feature_request",
      }),
    ).toEqual({
      description: "Explain the problem",
      reporter_id: "agent-a",
      title: "Better diagnostics",
      type: "feature_request",
    });
    expect(
      SubmitFeedbackInputSchema.safeParse({
        description: "Description",
        reporter_id: "agent-a",
        title: "Title",
        type: "suggestion",
      }).success,
    ).toBe(false);
    expect(
      SubmitFeedbackInputSchema.safeParse({
        description: "Description",
        extra: true,
        reporter_id: "agent-a",
        title: "Title",
        type: "issue",
      }).success,
    ).toBe(false);
  });

  test("agent discovery exposes validated opaque pagination cursors", (): void => {
    const cursor: string = encodeAgentCursor(AgentId.parse("agent-a"));
    const query: ReturnType<typeof listAgentsQuery> = listAgentsQuery(
      ListAgentsInputSchema.parse({ cursor, limit: 25, state: "closed" }),
    );
    if (query.cursor === null) throw new Error("Expected decoded agent cursor");
    expect(query.cursor.value).toBe("agent-a");
    expect(query.limit).toBe(25);
    expect(query.state).toBe("closed");
    expect(
      (): ReturnType<typeof listAgentsQuery> =>
        listAgentsQuery(ListAgentsInputSchema.parse({ cursor: "not-a-cursor" })),
    ).toThrow("Invalid agent cursor");
    expect(ListAgentsInputSchema.parse({})).toEqual({ limit: 1_000, state: "active" });
    expect(ListAgentsOutputSchema.safeParse({ agents: [], next_cursor: null }).success).toBe(true);
    expect(ListAgentsOutputSchema.safeParse({ agents: [] }).success).toBe(false);
  });

  test("lease-renewing reads are not advertised as read-only or idempotent", (): void => {
    const tools: Tool[] = toolsForPrincipal(exposure(null));
    for (const name of ["get_messages", "wait_for_messages", "list_notices"]) {
      const tool: Tool | undefined = tools.find(
        (candidate: Tool): boolean => candidate.name === name,
      );
      if (tool === undefined) throw new Error(`Missing tool ${name}`);
      const annotations: Tool["annotations"] = tool.annotations;
      if (annotations === undefined) throw new Error(`Missing annotations for ${name}`);
      expect(annotations.readOnlyHint).toBe(false);
      expect(annotations.idempotentHint).toBe(false);
    }
  });

  test("feedback submission is a non-destructive plaintext mutation", (): void => {
    const tool: Tool | undefined = toolsForPrincipal(exposure(null)).find(
      (candidate: Tool): boolean => candidate.name === "submit_feedback",
    );
    if (tool === undefined || tool.annotations === undefined) {
      throw new Error("Missing feedback tool annotations");
    }
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(false);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.description).toContain("maintainer-readable plaintext");
    expect(tool.description).toContain("vulnerability details");
    expect(tool.description).toContain("security/advisories/new");
  });

  test("advertises only retry-safe orchestration mutations as idempotent", (): void => {
    const tenantId: TenantId = TenantId.parse("00000000-0000-4000-8000-000000000001");
    const principal: HostedPrincipal = {
      kind: "tenant",
      personalId: PersonalId.parse("20000000-0000-4000-8000-000000000001"),
      role: "tenant_admin",
      tenantId,
      tokenId: "10000000-0000-4000-8000-000000000009",
    };
    const tools: Tool[] = toolsForPrincipal({
      ...exposure(principal),
      orchestrationEnabled: true,
    });
    const setPolicy: Tool | undefined = tools.find(
      (tool: Tool): boolean => tool.name === "set_orchestrator_policy",
    );
    const ask: Tool | undefined = tools.find(
      (tool: Tool): boolean => tool.name === "ask_orchestrator",
    );
    if (setPolicy === undefined || setPolicy.annotations === undefined) {
      throw new Error("Expected set policy annotations");
    }
    if (ask === undefined || ask.annotations === undefined) {
      throw new Error("Expected ask orchestrator annotations");
    }
    expect(setPolicy.annotations.idempotentHint).toBe(false);
    expect(ask.annotations.idempotentHint).toBe(true);
  });
});
