import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { TenantId } from "../src/domain/value-objects.js";
import type { HostedPrincipal } from "../src/hosted/control-plane.js";
import { type ToolExposure, toolsForPrincipal } from "../src/mcp/murmur-tool-definitions.js";

const DATA_TOOLS: readonly string[] = [
  "broadcast_message",
  "close_agent",
  "end_session",
  "get_message_history",
  "get_messages",
  "list_agents",
  "list_notices",
  "mark_messages_read",
  "post_notice",
  "register_agent",
  "resolve_notice",
  "send_message",
  "wait_for_messages",
  "withdraw_notice",
];
const TENANT_ADMIN_TOOLS: readonly string[] = [
  "create_access_token",
  "list_access_tokens",
  "revoke_access_token",
];
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
    expect(names(exposure(null))).toEqual(DATA_TOOLS);
    expect(names(exposure(tenantAgent))).toEqual(DATA_TOOLS);
  });

  test("tenant administrators add only tenant token lifecycle tools", (): void => {
    const principal: HostedPrincipal = {
      kind: "tenant",
      role: "tenant_admin",
      tenantId: TenantId.parse("00000000-0000-4000-8000-000000000001"),
      tokenId: "10000000-0000-4000-8000-000000000002",
    };
    expect(names(exposure(principal))).toEqual([...DATA_TOOLS, ...TENANT_ADMIN_TOOLS].sort());
  });

  test("bootstrap sessions expose one tool only while the bootstrap proof exists", (): void => {
    const principal: HostedPrincipal = {
      keyId: "bootstrap",
      kind: "bootstrap",
      tokenId: "10000000-0000-4000-8000-000000000003",
    };
    expect(names(exposure(principal))).toEqual(["bootstrap_operator"]);
    expect(names({ ...exposure(principal), bootstrapEnabled: false })).toEqual([]);
  });

  test("operator sessions expose no tenant data tools and honor rollout gates", (): void => {
    const principal: HostedPrincipal = {
      credentialHash: Buffer.alloc(32, 7),
      keyId: "operator",
      kind: "operator",
      tokenId: "10000000-0000-4000-8000-000000000004",
    };
    expect(names(exposure(principal))).toEqual(OPERATOR_TOOLS);
    expect(
      names({
        ...exposure(principal),
        legacyAdoptionEnabled: false,
        tenantOnboardingEnabled: false,
      }),
    ).toEqual(
      OPERATOR_TOOLS.filter(
        (name: string): boolean =>
          name !== "adopt_legacy_founding_token" && name !== "create_tenant",
      ),
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
});
