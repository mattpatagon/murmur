import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RegisterAgentOutputSchema } from "../src/domain/contracts.js";
import {
  type SubmitFeedbackOutput,
  SubmitFeedbackOutputSchema,
} from "../src/domain/feedback-contracts.js";
import { type ClientHarness, callValidated, connectClient } from "./support/mcp-client-harness.js";

test("an MCP agent persists issues and feature requests as maintainer feedback", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-feedback-mcp-"));
  const databasePath: string = join(directory, "messages.db");
  const reporter: ClientHarness = await connectClient("feedback-reporter", databasePath);
  try {
    await callValidated(
      reporter.client,
      "register_agent",
      { agent_id: "feedback-agent", display_name: "Feedback Agent" },
      RegisterAgentOutputSchema,
    );
    const issue: SubmitFeedbackOutput = await callValidated(
      reporter.client,
      "submit_feedback",
      {
        description: "The MCP response loses the stored type.",
        idempotency_key: "feedback-mcp-1",
        reporter_id: "feedback-agent",
        title: "Preserve feedback type",
        type: "issue",
      },
      SubmitFeedbackOutputSchema,
    );
    const feature: SubmitFeedbackOutput = await callValidated(
      reporter.client,
      "submit_feedback",
      {
        context: {
          branch: "feedback/context-override",
          client: "claude",
          repository: "mattpatagon/murmur-context",
        },
        description: "Let maintainers filter submissions by repository.",
        reporter_id: "feedback-agent",
        title: "Filter feedback",
        type: "feature_request",
      },
      SubmitFeedbackOutputSchema,
    );
    const retry: SubmitFeedbackOutput = await callValidated(
      reporter.client,
      "submit_feedback",
      {
        description: "The MCP response loses the stored type.",
        idempotency_key: "feedback-mcp-1",
        reporter_id: "feedback-agent",
        title: "Preserve feedback type",
        type: "issue",
      },
      SubmitFeedbackOutputSchema,
    );
    expect(issue.duplicate).toBe(false);
    expect(issue.submission.type).toBe("issue");
    expect(issue.submission.context).toEqual({
      branch: "feature/mcp-context",
      client: "codex",
      repository: "mattpatagon/murmur",
    });
    expect(feature.submission.type).toBe("feature_request");
    expect(feature.submission.context).toEqual({
      branch: "feedback/context-override",
      client: "claude",
      repository: "mattpatagon/murmur-context",
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.submission.submission_id).toBe(issue.submission.submission_id);

    const database: Database = new Database(databasePath, { readonly: true });
    try {
      const rows: unknown[] = database
        .query<unknown, []>(`
          SELECT submission_type, reporter_id, repository_name, branch_name, client_name,
            title, description
          FROM feedback_submissions ORDER BY submission_type DESC
        `)
        .all();
      expect(rows).toEqual([
        {
          branch_name: "feature/mcp-context",
          client_name: "codex",
          description: "The MCP response loses the stored type.",
          reporter_id: "feedback-agent",
          repository_name: "mattpatagon/murmur",
          submission_type: "issue",
          title: "Preserve feedback type",
        },
        {
          branch_name: "feedback/context-override",
          client_name: "claude",
          description: "Let maintainers filter submissions by repository.",
          reporter_id: "feedback-agent",
          repository_name: "mattpatagon/murmur-context",
          submission_type: "feature_request",
          title: "Filter feedback",
        },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await Promise.allSettled([reporter.client.close()]);
    rmSync(directory, { force: true, recursive: true });
  }
});
