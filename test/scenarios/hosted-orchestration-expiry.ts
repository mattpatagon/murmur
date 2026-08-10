import { expect } from "bun:test";

import postgres, { type Sql, type TransactionSql } from "postgres";

import {
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type CreateOrchestratorTokenOutput,
  CreateOrchestratorTokenOutputSchema,
  type GetOrchestratorOutput,
  GetOrchestratorOutputSchema,
  SetOrchestratorPolicyOutputSchema,
} from "../../src/hosted/orchestration-contracts.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import {
  callTool,
  callToolExpectingError,
  testTlsConfiguration,
} from "../support/hosted-mcp-harness.js";
import { runConcurrentPeerRegistration } from "../support/orchestration-race-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

async function verifyPolicyQuota(
  database: Sql,
  scenario: HostedTenantScenario,
  orchestratorTokenId: string,
): Promise<void> {
  let rejected: boolean = false;
  try {
    await database.begin(async (transaction: TransactionSql): Promise<void> => {
      await transaction`
        INSERT INTO murmur.orchestrator_policies(
          tenant_id, scope_kind, scope_owner_id, repository_name,
          orchestrator_token_id, instructions, enabled,
          created_by_token_id, updated_by_token_id
        )
        SELECT
          ${scenario.tenantB.tenant.tenant_id}::uuid,
          'personal',
          pg_catalog.gen_random_uuid(),
          '',
          ${orchestratorTokenId}::uuid,
          'Quota rollback fixture',
          true,
          ${scenario.tenantB.token.token_id}::uuid,
          ${scenario.tenantB.token.token_id}::uuid
        FROM pg_catalog.generate_series(1, 999)
      `;
      await transaction`
        INSERT INTO murmur.orchestrator_policies(
          tenant_id, scope_kind, scope_owner_id, repository_name,
          orchestrator_token_id, instructions, enabled,
          created_by_token_id, updated_by_token_id
        ) VALUES (
          ${scenario.tenantB.tenant.tenant_id}::uuid,
          'personal',
          pg_catalog.gen_random_uuid(),
          '',
          ${orchestratorTokenId}::uuid,
          'Quota rejection fixture',
          true,
          ${scenario.tenantB.token.token_id}::uuid,
          ${scenario.tenantB.token.token_id}::uuid
        )
      `;
    });
  } catch (error: unknown) {
    if (error instanceof postgres.PostgresError && error.code === "54000") {
      rejected = true;
    } else {
      throw error;
    }
  }
  expect(rejected).toBe(true);
  const retainedRows: { readonly count: number }[] = await database`
    SELECT pg_catalog.count(*)::integer AS count
    FROM murmur.orchestrator_policies
    WHERE tenant_id = ${scenario.tenantB.tenant.tenant_id}::uuid
  `;
  expect(retainedRows).toEqual([{ count: 1 }]);
}

export async function verifyExpiredOrchestratorRotation(
  scenario: HostedTenantScenario,
): Promise<void> {
  const adminDatabaseUrl: string | undefined = scenario.configuredAdminDatabaseUrl;
  if (adminDatabaseUrl === undefined) return;
  const registrationRaceAgentId: string = `registration-race-${scenario.unique}`;
  const registrationRaceError: string = await runConcurrentPeerRegistration({
    agentId: registrationRaceAgentId,
    attemptMint: async (): Promise<string> =>
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.tenantB.token.secret,
        scenario.adminBSession,
        545,
        "create_orchestrator_token",
        { agent_id: registrationRaceAgentId, name: "Concurrent authority race" },
      ),
    databaseUrl: adminDatabaseUrl,
    tenantId: scenario.tenantB.tenant.tenant_id,
  });
  expect(registrationRaceError).toContain("reserved for a different authority");
  const bossAgentId: string = `expiring-boss-${scenario.unique}`;
  const boss: CreateOrchestratorTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantB.token.secret,
    scenario.adminBSession,
    546,
    "create_orchestrator_token",
    { agent_id: bossAgentId, name: "Expiring orchestrator" },
    CreateOrchestratorTokenOutputSchema,
  );
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.tenantB.token.secret,
      scenario.adminBSession,
      547,
      "create_orchestrator_token",
      { agent_id: bossAgentId, name: "Forbidden concurrent credential" },
    ),
  ).toContain("active orchestrator credential already reserves this agent ID");
  await callTool(
    scenario.server.mcpUrl,
    scenario.tenantB.token.secret,
    scenario.adminBSession,
    548,
    "set_orchestrator_policy",
    {
      instructions: "Resolve expiry and rotation decisions.",
      orchestrator_key_id: boss.token.key_id,
      scope_kind: "organization",
    },
    SetOrchestratorPolicyOutputSchema,
  );
  const requestArguments: Record<string, unknown> = {
    content: "Preserve this duplicate after authority expires.",
    idempotency_key: `orchestration-expiry-${scenario.unique}`,
    sender_id: scenario.senderB,
  };
  const original: AskOrchestratorOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    549,
    "ask_orchestrator",
    requestArguments,
    AskOrchestratorOutputSchema,
  );
  const database: Sql = postgres(adminDatabaseUrl, {
    connect_timeout: 10,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  try {
    await verifyPolicyQuota(database, scenario, boss.token.token_id);
    const expiredRows: { readonly token_id: string }[] = await database`
      UPDATE murmur.access_tokens
      SET expires_at = created_at + interval '1 microsecond'
      WHERE tenant_id = ${scenario.tenantB.tenant.tenant_id}::uuid
        AND token_id = ${boss.token.token_id}::uuid
        AND created_at + interval '1 microsecond' <= pg_catalog.statement_timestamp()
      RETURNING token_id::text AS token_id
    `;
    expect(expiredRows).toEqual([{ token_id: boss.token.token_id }]);
  } finally {
    await database.end({ timeout: 5 });
  }
  const resolution: GetOrchestratorOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    550,
    "get_orchestrator",
    {},
    GetOrchestratorOutputSchema,
  );
  expect(resolution.orchestrator).toBeNull();
  const duplicate: AskOrchestratorOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    551,
    "ask_orchestrator",
    requestArguments,
    AskOrchestratorOutputSchema,
  );
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.message.message_id).toBe(original.message.message_id);
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.agentBToken.token.secret,
      scenario.agentBSession,
      552,
      "ask_orchestrator",
      {
        content: "Reject this first-time request after authority expires.",
        idempotency_key: `orchestration-expired-new-${scenario.unique}`,
        sender_id: scenario.senderB,
      },
    ),
  ).toContain("No active orchestrator is configured");
  const rotated: CreateOrchestratorTokenOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.tenantB.token.secret,
    scenario.adminBSession,
    553,
    "create_orchestrator_token",
    { agent_id: bossAgentId, name: "Rotated after expiry" },
    CreateOrchestratorTokenOutputSchema,
  );
  expect(rotated.token.agent_id).toBe(bossAgentId);
}
