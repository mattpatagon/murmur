import { expect } from "bun:test";

import { type RegisterAgentOutput, RegisterAgentOutputSchema } from "../../src/domain/contracts.js";
import {
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type IssuedOperatorTokenOutput,
  IssuedOperatorTokenOutputSchema,
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListTenantsOutput,
  ListTenantsOutputSchema,
  type ListTokensOutput,
  ListTokensOutputSchema,
} from "../../src/hosted/contracts.js";
import type { MurmurHttpServer } from "../../src/http-server.js";
import {
  callTool,
  callToolExpectingError,
  initialize,
  post,
  toolNames,
} from "../support/hosted-mcp-harness.js";

export type HostedTenantScenario = {
  readonly adminASession: string;
  readonly adminBSession: string;
  readonly agentASession: string;
  readonly agentAToken: IssuedTokenOutput;
  readonly agentBSession: string;
  readonly agentBToken: IssuedTokenOutput;
  readonly configuredAdminDatabaseUrl: string | undefined;
  readonly operatorSession: string;
  readonly operatorToken: string;
  readonly receiverA: string;
  readonly receiverB: string;
  readonly senderA: string;
  readonly senderB: string;
  readonly server: MurmurHttpServer;
  readonly tenantA: CreateTenantOutput;
  readonly tenantB: CreateTenantOutput;
  readonly unique: string;
};

export type HostedTenantProvisioningInput = {
  readonly configuredAdminDatabaseUrl: string | undefined;
  readonly operatorSession: string;
  readonly operatorToken: string;
  readonly server: MurmurHttpServer;
  readonly unique: string;
};

export async function provisionHostedTenantScenario(
  input: HostedTenantProvisioningInput,
): Promise<HostedTenantScenario> {
  const operatorSession: string = input.operatorSession;
  const operatorToken: string = input.operatorToken;
  const server: MurmurHttpServer = input.server;
  const unique: string = input.unique;
  const tenantA: CreateTenantOutput = await callTool(
    server.mcpUrl,
    operatorToken,
    operatorSession,
    3,
    "create_tenant",
    { display_name: `Tenant A ${unique}`, slug: `tenant-a-${unique}` },
    CreateTenantOutputSchema,
  );
  const tenantB: CreateTenantOutput = await callTool(
    server.mcpUrl,
    operatorToken,
    operatorSession,
    4,
    "create_tenant",
    { display_name: `Tenant B ${unique}`, slug: `tenant-b-${unique}` },
    CreateTenantOutputSchema,
  );
  const listedTenants: ListTenantsOutput = await callTool(
    server.mcpUrl,
    operatorToken,
    operatorSession,
    401,
    "list_tenants",
    { limit: 2 },
    ListTenantsOutputSchema,
  );
  expect(listedTenants.tenants).toHaveLength(2);
  expect(listedTenants.next_cursor).not.toBeNull();
  const mintedAdministrator: IssuedTokenOutput = await callTool(
    server.mcpUrl,
    operatorToken,
    operatorSession,
    402,
    "mint_tenant_admin_token",
    { name: "Operator-minted tenant A administrator", tenant_id: tenantA.tenant.tenant_id },
    IssuedTokenOutputSchema,
  );
  const mintedAdministratorSession: string = await initialize(
    server.mcpUrl,
    mintedAdministrator.token.secret,
    "operator-minted-admin-test",
  );
  expect(
    await toolNames(server.mcpUrl, mintedAdministrator.token.secret, mintedAdministratorSession),
  ).toContain("create_access_token");

  const adminASession: string = await initialize(
    server.mcpUrl,
    tenantA.token.secret,
    "tenant-a-admin-test",
  );
  const adminBSession: string = await initialize(
    server.mcpUrl,
    tenantB.token.secret,
    "tenant-b-admin-test",
  );
  const adminTools: readonly string[] = await toolNames(
    server.mcpUrl,
    tenantA.token.secret,
    adminASession,
  );
  expect(adminTools).toContain("register_agent");
  expect(adminTools).toContain("create_access_token");
  expect(adminTools).not.toContain("create_tenant");

  const agentAToken: IssuedTokenOutput = await callTool(
    server.mcpUrl,
    tenantA.token.secret,
    adminASession,
    5,
    "create_access_token",
    { name: "Tenant A agent", role: "agent" },
    IssuedTokenOutputSchema,
  );
  const agentBToken: IssuedTokenOutput = await callTool(
    server.mcpUrl,
    tenantB.token.secret,
    adminBSession,
    6,
    "create_access_token",
    { name: "Tenant B agent", role: "agent" },
    IssuedTokenOutputSchema,
  );
  const listedAccessTokens: ListTokensOutput = await callTool(
    server.mcpUrl,
    tenantA.token.secret,
    adminASession,
    403,
    "list_access_tokens",
    { limit: 2 },
    ListTokensOutputSchema,
  );
  expect(listedAccessTokens.tokens).toHaveLength(2);
  expect(listedAccessTokens.next_cursor).not.toBeNull();
  const expiration: string = new Date(Date.now() + 3_000).toISOString();
  const expiringOperator: IssuedOperatorTokenOutput = await callTool(
    server.mcpUrl,
    operatorToken,
    operatorSession,
    404,
    "create_operator_token",
    { expires_at: expiration, name: "Expiring operator" },
    IssuedOperatorTokenOutputSchema,
  );
  const expiringTenantToken: IssuedTokenOutput = await callTool(
    server.mcpUrl,
    tenantA.token.secret,
    adminASession,
    405,
    "create_access_token",
    { expires_at: expiration, name: "Expiring tenant agent", role: "agent" },
    IssuedTokenOutputSchema,
  );
  const expiringOperatorSession: string = await initialize(
    server.mcpUrl,
    expiringOperator.token.secret,
    "expiring-operator-test",
  );
  const expiringTenantSession: string = await initialize(
    server.mcpUrl,
    expiringTenantToken.token.secret,
    "expiring-tenant-test",
  );
  await Bun.sleep(3_200);
  const expiredOperatorRequest: Response = await post(
    server.mcpUrl,
    expiringOperator.token.secret,
    expiringOperatorSession,
    { id: 406, jsonrpc: "2.0", method: "tools/list", params: {} },
  );
  const expiredTenantRequest: Response = await post(
    server.mcpUrl,
    expiringTenantToken.token.secret,
    expiringTenantSession,
    { id: 407, jsonrpc: "2.0", method: "tools/list", params: {} },
  );
  expect(expiredOperatorRequest.status).toBe(401);
  expect(expiredTenantRequest.status).toBe(401);
  const agentASession: string = await initialize(
    server.mcpUrl,
    agentAToken.token.secret,
    "tenant-a-agent-test",
  );
  const agentBSession: string = await initialize(
    server.mcpUrl,
    agentBToken.token.secret,
    "tenant-b-agent-test",
  );
  expect(await toolNames(server.mcpUrl, agentAToken.token.secret, agentASession)).not.toContain(
    "create_access_token",
  );
  const crossSession: Response = await post(server.mcpUrl, tenantB.token.secret, adminASession, {
    id: 9,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  expect(crossSession.status).toBe(404);
  expect(
    await callToolExpectingError(
      server.mcpUrl,
      tenantA.token.secret,
      adminASession,
      91,
      "create_operator_token",
      { name: "Forbidden operator" },
    ),
  ).toContain("Unknown tool");
  expect(
    await callToolExpectingError(
      server.mcpUrl,
      agentAToken.token.secret,
      agentASession,
      92,
      "create_access_token",
      { name: "Forbidden administrator", role: "agent" },
    ),
  ).toContain("Unknown tool");

  const senderA: string = `hosted-shared-sender-${unique}`;
  const receiverA: string = `hosted-a-receiver-${unique}`;
  const senderB: string = senderA;
  const receiverB: string = `hosted-b-receiver-${unique}`;
  const registrations: readonly [string, string, string][] = [
    [agentAToken.token.secret, agentASession, senderA],
    [agentAToken.token.secret, agentASession, receiverA],
    [agentBToken.token.secret, agentBSession, senderB],
    [agentBToken.token.secret, agentBSession, receiverB],
  ];
  let registrationId: number = 10;
  for (const [token, session, agentId] of registrations) {
    const registration: RegisterAgentOutput = await callTool(
      server.mcpUrl,
      token,
      session,
      registrationId,
      "register_agent",
      { agent_id: agentId, display_name: agentId },
      RegisterAgentOutputSchema,
    );
    expect(registration.agent.agent_id).toBe(agentId);
    registrationId += 1;
  }

  return {
    adminASession,
    adminBSession,
    agentASession,
    agentAToken,
    agentBSession,
    agentBToken,
    configuredAdminDatabaseUrl: input.configuredAdminDatabaseUrl,
    operatorSession,
    operatorToken,
    receiverA,
    receiverB,
    senderA,
    senderB,
    server,
    tenantA,
    tenantB,
    unique,
  };
}
