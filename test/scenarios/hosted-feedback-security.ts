import { expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { postgresSslOptions } from "../../src/postgres-tls.js";
import { callToolExpectingError, testTlsConfiguration } from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

export async function verifyFeedbackAuthorityBoundary(
  scenario: HostedTenantScenario,
  orchestratorId: string,
): Promise<void> {
  const idempotencyKey: string = `feedback-authority-denied-${scenario.unique}`;
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.tenantA.token.secret,
      scenario.adminASession,
      507,
      "submit_feedback",
      {
        description: "A peer must not attribute feedback to an orchestrator.",
        idempotency_key: idempotencyKey,
        reporter_id: orchestratorId,
        title: "Forged reporter",
        type: "issue",
      },
    ),
  ).toContain("reserved for a different authority");

  const adminUrl: string | undefined = scenario.configuredAdminDatabaseUrl;
  if (adminUrl === undefined) return;
  const database: Sql = postgres(adminUrl, {
    max: 1,
    ssl: postgresSslOptions(adminUrl, testTlsConfiguration),
  });
  try {
    const rows: { readonly count: number }[] = await database`
      SELECT count(*)::integer AS count
      FROM murmur.feedback_submissions
      WHERE tenant_id = ${scenario.tenantA.tenant.tenant_id}::uuid
        AND reporter_id = ${orchestratorId}
        AND idempotency_key = ${idempotencyKey}
    `;
    expect(rows).toEqual([{ count: 0 }]);
  } finally {
    await database.end({ timeout: 5 });
  }
}
