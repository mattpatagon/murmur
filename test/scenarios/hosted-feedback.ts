import { expect } from "bun:test";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

import {
  type SubmitFeedbackOutput,
  SubmitFeedbackOutputSchema,
} from "../../src/domain/feedback-contracts.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import {
  callTool,
  callToolExpectingError,
  testTlsConfiguration,
  toolNames,
} from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

type StoredFeedbackRow = {
  readonly branch_name: string;
  readonly client_name: "claude" | "codex";
  readonly created_at: string;
  readonly description: string;
  readonly feedback_id: string;
  readonly idempotency_key: string | null;
  readonly reporter_generation: number;
  readonly reporter_id: string;
  readonly repository_name: string;
  readonly submission_type: "feature_request" | "issue";
  readonly tenant_id: string;
  readonly title: string;
};

const StoredFeedbackRowSchema: z.ZodType<StoredFeedbackRow> = z.strictObject({
  branch_name: z.string(),
  client_name: z.enum(["claude", "codex"]),
  created_at: z.string(),
  description: z.string(),
  feedback_id: z.string().uuid(),
  idempotency_key: z.string().nullable(),
  reporter_generation: z.number().int().positive(),
  reporter_id: z.string(),
  repository_name: z.string(),
  submission_type: z.enum(["issue", "feature_request"]),
  tenant_id: z.string().uuid(),
  title: z.string(),
});

export async function verifyHostedFeedback(scenario: HostedTenantScenario): Promise<void> {
  expect(
    await toolNames(
      scenario.server.mcpUrl,
      scenario.agentAToken.token.secret,
      scenario.agentASession,
    ),
  ).toContain("submit_feedback");
  const idempotencyKey: string = `hosted-feedback-${scenario.unique}`;
  const issueArguments: Record<string, unknown> = {
    description: "The hosted feedback path must preserve tenant and reporter context.",
    idempotency_key: idempotencyKey,
    reporter_id: scenario.senderA,
    title: "Preserve hosted feedback context",
    type: "issue",
  };
  const issue: SubmitFeedbackOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    420,
    "submit_feedback",
    issueArguments,
    SubmitFeedbackOutputSchema,
  );
  const retry: SubmitFeedbackOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentAToken.token.secret,
    scenario.agentASession,
    421,
    "submit_feedback",
    issueArguments,
    SubmitFeedbackOutputSchema,
  );
  expect(issue.duplicate).toBe(false);
  expect(issue.submission.type).toBe("issue");
  expect(issue.submission.reporter_id).toBe(scenario.senderA);
  expect(issue.submission.context).toEqual({
    branch: "feature/hosted-isolation",
    client: "codex",
    repository: "mattpatagon/murmur",
  });
  expect(retry.duplicate).toBe(true);
  expect(retry.submission.submission_id).toBe(issue.submission.submission_id);
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.agentAToken.token.secret,
      scenario.agentASession,
      422,
      "submit_feedback",
      { ...issueArguments, title: "Conflicting title" },
    ),
  ).toContain("already used for different feedback");

  const feature: SubmitFeedbackOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.agentBToken.token.secret,
    scenario.agentBSession,
    423,
    "submit_feedback",
    {
      description: "Let maintainers inspect tenant-scoped feedback independently.",
      idempotency_key: idempotencyKey,
      reporter_id: scenario.senderB,
      title: "Tenant-scoped feedback views",
      type: "feature_request",
    },
    SubmitFeedbackOutputSchema,
  );
  expect(feature.submission.type).toBe("feature_request");
  expect(feature.submission.submission_id).not.toBe(issue.submission.submission_id);

  const concurrentArguments: Record<string, unknown> = {
    description: "Concurrent retries must converge on one stored submission.",
    idempotency_key: `hosted-feedback-race-${scenario.unique}`,
    reporter_id: scenario.senderA,
    title: "Serialize feedback retries",
    type: "issue",
  };
  const concurrent: SubmitFeedbackOutput[] = await Promise.all([
    callTool(
      scenario.server.mcpUrl,
      scenario.agentAToken.token.secret,
      scenario.agentASession,
      424,
      "submit_feedback",
      concurrentArguments,
      SubmitFeedbackOutputSchema,
    ),
    callTool(
      scenario.server.mcpUrl,
      scenario.tenantA.token.secret,
      scenario.adminASession,
      425,
      "submit_feedback",
      concurrentArguments,
      SubmitFeedbackOutputSchema,
    ),
  ]);
  expect(
    concurrent.map((result: SubmitFeedbackOutput): boolean => result.duplicate).sort(),
  ).toEqual([false, true]);
  const firstConcurrent: SubmitFeedbackOutput | undefined = concurrent[0];
  const secondConcurrent: SubmitFeedbackOutput | undefined = concurrent[1];
  if (firstConcurrent === undefined || secondConcurrent === undefined) {
    throw new Error("Concurrent feedback results were incomplete");
  }
  expect(firstConcurrent.submission.submission_id).toBe(secondConcurrent.submission.submission_id);

  const configuredAdminDatabaseUrl: string | undefined = scenario.configuredAdminDatabaseUrl;
  if (configuredAdminDatabaseUrl === undefined) return;
  const database: Sql = postgres(configuredAdminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
  });
  try {
    const raw: unknown = await database`
      SELECT tenant_id::text AS tenant_id, feedback_id::text AS feedback_id,
        submission_type, reporter_id, repository_name, branch_name, client_name,
        title, description, idempotency_key, reporter_generation,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM murmur.feedback_submissions
      WHERE feedback_id IN (
        ${issue.submission.submission_id}::uuid,
        ${feature.submission.submission_id}::uuid
      )
      ORDER BY submission_type DESC
    `;
    const rows: StoredFeedbackRow[] = z.array(StoredFeedbackRowSchema).parse(raw);
    expect(rows).toEqual([
      {
        branch_name: "feature/hosted-isolation",
        client_name: "codex",
        created_at: issue.submission.created_at,
        description: "The hosted feedback path must preserve tenant and reporter context.",
        feedback_id: issue.submission.submission_id,
        idempotency_key: idempotencyKey,
        reporter_generation: 1,
        reporter_id: scenario.senderA,
        repository_name: "mattpatagon/murmur",
        submission_type: "issue",
        tenant_id: scenario.tenantA.tenant.tenant_id,
        title: "Preserve hosted feedback context",
      },
      {
        branch_name: "feature/hosted-isolation",
        client_name: "codex",
        created_at: feature.submission.created_at,
        description: "Let maintainers inspect tenant-scoped feedback independently.",
        feedback_id: feature.submission.submission_id,
        idempotency_key: idempotencyKey,
        reporter_generation: 1,
        reporter_id: scenario.senderB,
        repository_name: "mattpatagon/murmur",
        submission_type: "feature_request",
        tenant_id: scenario.tenantB.tenant.tenant_id,
        title: "Tenant-scoped feedback views",
      },
    ]);
  } finally {
    await database.end({ timeout: 5 });
  }
}
