import { expect } from "bun:test";

import { RegisterAgentOutputSchema } from "../../src/domain/contracts.js";
import {
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListAdminAuditOutput,
  ListAdminAuditOutputSchema,
  type RevokeTokenOutput,
  RevokeTokenOutputSchema,
  type TenantStatusOutput,
  TenantStatusOutputSchema,
} from "../../src/hosted/contracts.js";
import {
  bootstrapLegacyToken,
  callTool,
  initialize,
  post,
  subscribeInbox,
  subscribeInboxExpectingError,
  toolNames,
} from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyHostedTenantLifecycle(scenario: HostedTenantScenario): Promise<void> {
  const crossRevoke: RevokeTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantB.token.secret,
    scenario.adminBSession,
    25,
    "revoke_access_token",
    { key_id: scenario.agentAToken.token.key_id },
    RevokeTokenOutputSchema,
  );
  expect(crossRevoke.revoked).toBe(false);
  const revoked: RevokeTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    26,
    "revoke_access_token",
    { key_id: scenario.agentAToken.token.key_id },
    RevokeTokenOutputSchema,
  );
  expect(revoked.revoked).toBe(true);
  await Bun.sleep(20);
  const revokedRequest: Response = await post(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    { id: 27, jsonrpc: "2.0", method: "tools/list", params: {} },
  );
  expect(revokedRequest.status).toBe(401);

  const subscriptionAgentIds: string[] = [];
  for (let index: number = 0; index < 11; index += 1) {
    const subscriptionAgentId: string = `hosted-subscription-${index}-${scenario.unique}`;
    subscriptionAgentIds.push(subscriptionAgentId);
    await callTool(
      scenario.server.mcpUrl,
      scenario.tenantA.token.secret,
      scenario.adminASession,
      500 + index,
      "register_agent",
      { agent_id: subscriptionAgentId, display_name: subscriptionAgentId },
      RegisterAgentOutputSchema,
    );
  }
  for (let index: number = 0; index < 10; index += 1) {
    const subscriptionAgentId: string | undefined = subscriptionAgentIds[index];
    if (subscriptionAgentId === undefined) throw new Error("Subscription agent is missing");
    await subscribeInbox(
      scenario.server.mcpUrl,
      scenario.tenantA.token.secret,
      scenario.adminASession,
      520 + index,
      `murmur://inbox/${subscriptionAgentId}`,
    );
  }
  expect(
    await subscribeInboxExpectingError(
      scenario.server.mcpUrl,
      scenario.tenantA.token.secret,
      scenario.adminASession,
      530,
      `murmur://inbox/${subscriptionAgentIds[10]}`,
    ),
  ).toContain("Inbox subscription capacity reached");

  const suspended: TenantStatusOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    28,
    "suspend_tenant",
    { tenant_id: scenario.tenantB.tenant.tenant_id },
    TenantStatusOutputSchema,
  );
  expect(suspended.changed).toBe(true);
  await Bun.sleep(20);
  const suspendedRequest: Response = await post(
    scenario.server.mcpUrl,
    scenario.tenantB.token.secret,
    scenario.adminBSession,
    { id: 29, jsonrpc: "2.0", method: "tools/list", params: {} },
  );
  expect(suspendedRequest.status).toBe(401);
  const restored: TenantStatusOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    30,
    "restore_tenant",
    { tenant_id: scenario.tenantB.tenant.tenant_id },
    TenantStatusOutputSchema,
  );
  expect(restored.changed).toBe(true);
  const audit: ListAdminAuditOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    31,
    "list_admin_audit",
    { limit: 100 },
    ListAdminAuditOutputSchema,
  );
  if (bootstrapLegacyToken !== undefined) {
    expect(
      audit.events.some(
        (event: ListAdminAuditOutput["events"][number]): boolean =>
          event.action === "operator.bootstrap",
      ),
    ).toBe(true);
  }
  expect(
    audit.events.some(
      (event: ListAdminAuditOutput["events"][number]): boolean => event.action === "tenant.suspend",
    ),
  ).toBe(true);
  expect(
    await toolNames(
      scenario.server.mcpUrl,
      scenario.tenantB.token.secret,
      await initialize(
        scenario.server.mcpUrl,
        scenario.tenantB.token.secret,
        "tenant-b-restored-test",
      ),
    ),
  ).toContain("register_agent");

  const foundingSuspended: TenantStatusOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    32,
    "suspend_tenant",
    { tenant_id: scenario.tenantA.tenant.tenant_id },
    TenantStatusOutputSchema,
  );
  expect(foundingSuspended.changed).toBe(true);
  await Bun.sleep(20);
  const foundingSuspendedRequest: Response = await post(
    scenario.server.mcpUrl,
    scenario.tenantA.token.secret,
    scenario.adminASession,
    { id: 33, jsonrpc: "2.0", method: "tools/list", params: {} },
  );
  expect(foundingSuspendedRequest.status).toBe(401);
  const foundingReplacement: IssuedTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    34,
    "mint_tenant_admin_token",
    { name: "Founding tenant recovery", tenant_id: scenario.tenantA.tenant.tenant_id },
    IssuedTokenOutputSchema,
  );
  const foundingRestored: TenantStatusOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    35,
    "restore_tenant",
    { tenant_id: scenario.tenantA.tenant.tenant_id },
    TenantStatusOutputSchema,
  );
  expect(foundingRestored.changed).toBe(true);
  expect(
    await toolNames(
      scenario.server.mcpUrl,
      foundingReplacement.token.secret,
      await initialize(
        scenario.server.mcpUrl,
        foundingReplacement.token.secret,
        "founding-tenant-recovered-test",
      ),
    ),
  ).toContain("create_access_token");
}
