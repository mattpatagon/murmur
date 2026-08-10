import { expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { postgresSslOptions } from "../../src/postgres-tls.js";
import { callToolExpectingError, testTlsConfiguration } from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyHostedTenantQuotas(scenario: HostedTenantScenario): Promise<void> {
  const configuredAdminDatabaseUrl: string | undefined = scenario.configuredAdminDatabaseUrl;
  if (configuredAdminDatabaseUrl === undefined) return;
  const quotaDatabase: Sql = postgres(configuredAdminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
  });
  try {
    await quotaDatabase`
      DELETE FROM murmur.access_tokens
      WHERE tenant_id = ${scenario.tenantA.tenant.tenant_id}::uuid
        AND (
          revoked_at IS NOT NULL
          OR expires_at <= pg_catalog.statement_timestamp()
        )
    `;
    await quotaDatabase`
      UPDATE murmur.tenant_resource_usage
      SET
        access_token_count = 1000,
        agent_count = 1000,
        broadcast_content_bytes = 67108864,
        broadcast_count = 10000,
        message_count = 100000
      WHERE tenant_id = ${scenario.tenantA.tenant.tenant_id}::uuid
    `;
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.agentAToken.token.secret,
        scenario.agentASession,
        410,
        "register_agent",
        { agent_id: `quota-agent-${scenario.unique}`, display_name: "Quota rejected" },
      ),
    ).toContain("tenant agent quota exceeded");
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.agentAToken.token.secret,
        scenario.agentASession,
        411,
        "send_message",
        {
          content: "quota rejected",
          recipient_id: scenario.receiverA,
          sender_id: scenario.senderA,
        },
      ),
    ).toContain("tenant retained-message quota exceeded");
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.tenantA.token.secret,
        scenario.adminASession,
        412,
        "create_access_token",
        { name: "Quota rejected token", role: "agent" },
      ),
    ).toContain("tenant access-token quota exceeded");
    expect(
      await callToolExpectingError(
        scenario.server.mcpUrl,
        scenario.tenantA.token.secret,
        scenario.adminASession,
        413,
        "broadcast_message",
        {
          audience: { repository: "quota/no-recipients" },
          content: "quota rejected broadcast",
          sender_id: scenario.senderA,
        },
      ),
    ).toContain("tenant retained-broadcast quota exceeded");
  } finally {
    await quotaDatabase`
      UPDATE murmur.tenant_resource_usage AS usage
      SET
        agent_count = (
          SELECT count(*) FROM murmur.agents AS agent
          WHERE agent.tenant_id = usage.tenant_id
        ),
        access_token_count = (
          SELECT count(*) FROM murmur.access_tokens AS access_token
          WHERE access_token.tenant_id = usage.tenant_id
        ),
        broadcast_count = (
          SELECT count(*) FROM murmur.broadcasts AS broadcast
          WHERE broadcast.tenant_id = usage.tenant_id
        ),
        broadcast_content_bytes = (
          SELECT coalesce(sum(octet_length(broadcast.content)), 0)::bigint
          FROM murmur.broadcasts AS broadcast
          WHERE broadcast.tenant_id = usage.tenant_id
        ),
        message_count = (
          SELECT count(*) FROM murmur.messages AS message
          WHERE message.tenant_id = usage.tenant_id
        ),
        message_content_bytes = (
          SELECT coalesce(sum(octet_length(message.content)), 0)::bigint
          FROM murmur.messages AS message
          WHERE message.tenant_id = usage.tenant_id
        )
      WHERE usage.tenant_id = ${scenario.tenantA.tenant.tenant_id}::uuid
    `;
    await quotaDatabase.end({ timeout: 5 });
  }
}
