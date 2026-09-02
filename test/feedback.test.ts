import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type RequiredFeedbackContext,
  type SubmitFeedbackInput,
  SubmitFeedbackInputSchema,
  submitFeedbackCommand,
} from "../src/domain/feedback-contracts.js";
import {
  FeedbackDescription,
  FeedbackTitle,
  type SubmitFeedbackCommand,
  type SubmitFeedbackResult,
} from "../src/domain/feedback-models.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { RegisterAgentResult } from "../src/domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  DisplayName,
  IdempotencyKey,
  Instant,
  RepositoryName,
} from "../src/domain/value-objects.js";
import { mapFeedbackRow } from "../src/storage/feedback-rows.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

type FeedbackFixture = {
  readonly clock: MutableClock;
  readonly path: string;
  readonly store: SqliteMessageStore;
};

function withFeedback(run: (fixture: FeedbackFixture) => void): void {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-feedback-"));
  const path: string = join(directory, "messages.db");
  const clock: MutableClock = new MutableClock(Instant.parse("2026-08-20T12:00:00.000Z"));
  const store: SqliteMessageStore = new SqliteMessageStore(path, clock);
  for (const id of ["alice", "bob"]) {
    store.registerAgent({
      agentId: AgentId.parse(id),
      displayName: DisplayName.parse(id),
      metadata: { repository: "mattpatagon/murmur" },
      sessionKey: SessionKey.parse(`${id}-pane`),
    });
  }
  try {
    run({ clock, path, store });
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function feedbackCommand(
  type: SubmitFeedbackCommand["type"] = "issue",
  key: string | null = "feedback-1",
  reporter: string = "alice",
): SubmitFeedbackCommand {
  return {
    branchName: BranchName.parse("feature/feedback"),
    client: AgentClient.parse("connector"),
    description: FeedbackDescription.parse("The submission path should preserve this detail."),
    idempotencyKey: key === null ? null : IdempotencyKey.parse(key),
    reporterId: AgentId.parse(reporter),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    sessionKey: SessionKey.parse(`${reporter}-pane`),
    title: FeedbackTitle.parse(type === "issue" ? "Submission fails" : "Add feedback search"),
    type,
  };
}

test("feedback input boundaries reject malformed or oversized submissions", (): void => {
  const base: SubmitFeedbackInput = {
    description: "Description",
    idempotency_key: "feedback-key",
    reporter_id: "alice",
    title: "Title",
    type: "issue",
  };
  const maximum: SubmitFeedbackInput = SubmitFeedbackInputSchema.parse({
    ...base,
    description: "d".repeat(100_000),
    idempotency_key: "k".repeat(200),
    title: "t".repeat(200),
  });
  expect(maximum.description).toHaveLength(100_000);
  expect(maximum.idempotency_key).toHaveLength(200);
  expect(maximum.title).toHaveLength(200);

  const invalidInputs: readonly unknown[] = [
    { ...base, description: "" },
    { ...base, description: "   " },
    { ...base, description: "d".repeat(100_001) },
    { ...base, idempotency_key: "" },
    { ...base, idempotency_key: "k".repeat(201) },
    { ...base, title: "" },
    { ...base, title: " ".repeat(3) },
    { ...base, title: "t".repeat(201) },
    { ...base, type: "suggestion" },
    { description: "Description", reporter_id: "alice", title: "Title" },
    { description: "Description", title: "Title", type: "issue" },
  ];
  for (const input of invalidInputs) {
    expect(SubmitFeedbackInputSchema.safeParse(input).success).toBe(false);
  }
  const context: RequiredFeedbackContext = {
    branch: "main",
    client: "codex",
    repository: "mattpatagon/murmur",
  };
  const parsedContext: Pick<SubmitFeedbackCommand, "branchName" | "client" | "repositoryName"> = {
    branchName: BranchName.parse(context.branch),
    client: AgentClient.parse(context.client),
    repositoryName: RepositoryName.parse(context.repository),
  };
  expect(
    (): SubmitFeedbackCommand =>
      submitFeedbackCommand(
        SubmitFeedbackInputSchema.parse({ ...base, reporter_id: "invalid reporter" }),
        parsedContext,
      ),
  ).toThrow("Use letters, numbers");
  expect(
    (): SubmitFeedbackCommand =>
      submitFeedbackCommand(
        SubmitFeedbackInputSchema.parse({ ...base, session_key: "invalid session key" }),
        parsedContext,
      ),
  ).toThrow();
});

test("persists issues and feature requests with exact reporter context", (): void => {
  withFeedback(({ clock, path, store }: FeedbackFixture): void => {
    const issue: SubmitFeedbackResult = store.submitFeedback(feedbackCommand());
    clock.set(Instant.parse("2026-08-20T12:01:00.000Z"));
    const feature: SubmitFeedbackResult = store.submitFeedback(
      feedbackCommand("feature_request", "feedback-2"),
    );

    expect(issue.duplicate).toBe(false);
    expect(issue.submission.type).toBe("issue");
    expect(issue.submission.title.value).toBe("Submission fails");
    expect(issue.submission.reporterId.value).toBe("alice");
    expect(issue.submission.reporterGeneration.value).toBe(1);
    expect(issue.submission.repositoryName.value).toBe("mattpatagon/murmur");
    expect(issue.submission.branchName.value).toBe("feature/feedback");
    expect(issue.submission.client.value).toBe("connector");
    expect(issue.submission.createdAt.toISOString()).toBe("2026-08-20T12:00:00.000Z");
    expect(feature.submission.type).toBe("feature_request");
    expect(feature.submission.createdAt.toISOString()).toBe("2026-08-20T12:01:00.000Z");
    expect(feature.submission.feedbackId.value).not.toBe(issue.submission.feedbackId.value);
    const database: Database = new Database(path, { readonly: true });
    try {
      expect(
        database
          .query<unknown, []>(`
            SELECT submission_count, content_bytes FROM feedback_usage WHERE singleton = 1
          `)
          .get(),
      ).toEqual({
        content_bytes:
          Buffer.byteLength(issue.submission.title.value + issue.submission.description.value) +
          Buffer.byteLength(feature.submission.title.value + feature.submission.description.value),
        submission_count: 2,
      });
    } finally {
      database.close();
    }
  });
});

test("idempotent retries preserve the winner and reject every semantic change", (): void => {
  withFeedback(({ store }: FeedbackFixture): void => {
    const original: SubmitFeedbackCommand = feedbackCommand();
    const first: SubmitFeedbackResult = store.submitFeedback(original);
    const retry: SubmitFeedbackResult = store.submitFeedback(original);
    expect(retry.duplicate).toBe(true);
    expect(retry.submission.feedbackId.value).toBe(first.submission.feedbackId.value);

    const conflicts: readonly SubmitFeedbackCommand[] = [
      { ...original, type: "feature_request" },
      { ...original, title: FeedbackTitle.parse("Different title") },
      { ...original, description: FeedbackDescription.parse("Different description") },
      { ...original, repositoryName: RepositoryName.parse("mattpatagon/other") },
      { ...original, branchName: BranchName.parse("other-branch") },
      { ...original, client: AgentClient.parse("claude") },
    ];
    for (const conflict of conflicts) {
      expect((): SubmitFeedbackResult => store.submitFeedback(conflict)).toThrow(
        "already used for different feedback",
      );
    }

    expect(store.submitFeedback(feedbackCommand("issue", "feedback-1", "bob")).duplicate).toBe(
      false,
    );
    const withoutKey: SubmitFeedbackResult = store.submitFeedback(feedbackCommand("issue", null));
    const secondWithoutKey: SubmitFeedbackResult = store.submitFeedback(
      feedbackCommand("issue", null),
    );
    expect(secondWithoutKey.submission.feedbackId.value).not.toBe(
      withoutKey.submission.feedbackId.value,
    );
  });
});

test("requires a registered open reporter before accepting feedback", (): void => {
  withFeedback(({ store }: FeedbackFixture): void => {
    expect(
      (): SubmitFeedbackResult =>
        store.submitFeedback(feedbackCommand("issue", "unknown", "unknown")),
    ).toThrow("Unknown agent");
    store.closeAgent({
      agentId: AgentId.parse("alice"),
      closeReason: "completed",
      expectedGeneration: AgentGeneration.parse(1),
    });
    expect(
      (): SubmitFeedbackResult => store.submitFeedback(feedbackCommand("issue", "closed")),
    ).toThrow("is closed");
  });
});

test("feedback retains reporter identity through garbage collection and generation changes", (): void => {
  withFeedback(({ clock, store }: FeedbackFixture): void => {
    const first: SubmitFeedbackResult = store.submitFeedback(feedbackCommand());
    expect(first.submission.reporterGeneration.value).toBe(1);
    store.closeAgent({
      agentId: AgentId.parse("alice"),
      closeReason: "completed",
      expectedGeneration: AgentGeneration.parse(1),
    });
    clock.set(clock.now().addDays(31));
    store.pruneExpired(clock.now());
    expect(store.getAgent(AgentId.parse("alice"))).not.toBeNull();
    const reopened: RegisterAgentResult = store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("alice"),
      metadata: { repository: "mattpatagon/murmur" },
      sessionKey: SessionKey.parse("alice-pane"),
    });
    expect(reopened.agent.generation.value).toBe(2);
    const second: SubmitFeedbackResult = store.submitFeedback(
      feedbackCommand("feature_request", "feedback-generation-two"),
    );
    expect(second.submission.reporterGeneration.value).toBe(2);
  });
});

test("idempotent retries still succeed at the exact retained count limit", (): void => {
  withFeedback(({ clock, path, store }: FeedbackFixture): void => {
    const original: SubmitFeedbackCommand = feedbackCommand();
    const first: SubmitFeedbackResult = store.submitFeedback(original);
    store.close();
    const database: Database = new Database(path);
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 9999
      )
      INSERT INTO feedback_submissions(
        feedback_id, submission_type, reporter_id, reporter_generation,
        repository_name, branch_name, client_name, title, description, created_at
      ) SELECT
        printf('00000000-0000-4000-8000-%012d', value), 'issue', 'alice', 1,
        'mattpatagon/murmur', 'feature/feedback', 'codex', 'Seed', 'Seed',
        '2026-08-20T12:00:00.000Z'
      FROM sequence
      ;
      UPDATE feedback_usage SET
        submission_count = (SELECT COUNT(*) FROM feedback_submissions),
        content_bytes = (
          SELECT COALESCE(SUM(
            length(CAST(title AS BLOB)) + length(CAST(description AS BLOB))
          ), 0) FROM feedback_submissions
        )
    `);
    database.close();
    const reopened: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      const retry: SubmitFeedbackResult = reopened.submitFeedback(original);
      expect(retry.duplicate).toBe(true);
      expect(retry.submission.feedbackId.value).toBe(first.submission.feedbackId.value);
      expect(
        (): SubmitFeedbackResult =>
          reopened.submitFeedback(feedbackCommand("feature_request", "overflow")),
      ).toThrow("capacity");
    } finally {
      reopened.close();
    }
  });
});

test("retained feedback enforces the exact UTF-8 content byte limit", (): void => {
  withFeedback(({ clock, path, store }: FeedbackFixture): void => {
    store.close();
    const database: Database = new Database(path);
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 671
      )
      INSERT INTO feedback_submissions(
        feedback_id, submission_type, reporter_id, reporter_generation,
        repository_name, branch_name, client_name, title, description, created_at
      ) SELECT
        printf('10000000-0000-4000-8000-%012d', value), 'issue', 'alice', 1,
        'mattpatagon/murmur', 'feature/feedback', 'codex', 'x',
        printf('%.*c', 99999, 'x'), '2026-08-20T12:00:00.000Z'
      FROM sequence;
      INSERT INTO feedback_submissions(
        feedback_id, submission_type, reporter_id, reporter_generation,
        repository_name, branch_name, client_name, title, description, created_at
      ) VALUES (
        '20000000-0000-4000-8000-000000000001', 'issue', 'alice', 1,
        'mattpatagon/murmur', 'feature/feedback', 'codex', 'x',
        printf('%.*c', 8857, 'x'), '2026-08-20T12:00:00.000Z'
      );
      INSERT INTO feedback_submissions(
        feedback_id, submission_type, reporter_id, reporter_generation,
        repository_name, branch_name, client_name, title, description, created_at
      ) VALUES (
        '20000000-0000-4000-8000-000000000002', 'feature_request', 'alice', 1,
        'mattpatagon/murmur', 'feature/feedback', 'codex', 'é', '🙂',
        '2026-08-20T12:00:00.000Z'
      );
      UPDATE feedback_usage SET
        submission_count = (SELECT COUNT(*) FROM feedback_submissions),
        content_bytes = (
          SELECT COALESCE(SUM(
            length(CAST(title AS BLOB)) + length(CAST(description AS BLOB))
          ), 0) FROM feedback_submissions
        );
    `);
    const usage: unknown = database
      .query<unknown, []>(`
        SELECT SUM(length(CAST(title AS BLOB)) + length(CAST(description AS BLOB))) AS bytes
        FROM feedback_submissions
      `)
      .get();
    expect(usage).toEqual({ bytes: 67_108_864 });
    expect(
      database
        .query<unknown, []>(`
          SELECT length(CAST(title AS BLOB)) + length(CAST(description AS BLOB)) AS bytes
          FROM feedback_submissions
          WHERE feedback_id = '20000000-0000-4000-8000-000000000002'
        `)
        .get(),
    ).toEqual({ bytes: 6 });
    database.close();
    const reopened: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      expect((): SubmitFeedbackResult => reopened.submitFeedback(feedbackCommand())).toThrow(
        "capacity",
      );
    } finally {
      reopened.close();
    }
  });
});

test("validates SQLite feedback constraints and persisted rows", (): void => {
  withFeedback(({ path, store }: FeedbackFixture): void => {
    store.close();
    const database: Database = new Database(path);
    try {
      expect((): void => {
        database.exec(`
          INSERT INTO feedback_submissions(
            feedback_id, submission_type, reporter_id, reporter_generation,
            repository_name, branch_name, client_name, title, description, created_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000001', 'issue', 'invalid reporter', 1,
            'invalid', 'main', 'codex', 'Title', 'Description',
            '2026-08-20T12:00:00.000Z'
          )
        `);
      }).toThrow("CHECK constraint failed");
    } finally {
      database.close();
    }
  });

  expect(
    (): ReturnType<typeof mapFeedbackRow> =>
      mapFeedbackRow({
        branch_name: "main",
        client_name: "codex",
        created_at: "not-an-instant",
        description: "Description",
        feedback_id: "00000000-0000-4000-8000-000000000001",
        idempotency_key: null,
        reporter_generation: 1,
        reporter_id: "alice",
        repository_name: "mattpatagon/murmur",
        submission_type: "suggestion",
        title: "Title",
      }),
  ).toThrow("Stored feedback submission failed runtime validation");
});

test("fails closed when SQLite feedback usage state is unavailable", (): void => {
  withFeedback(({ clock, path, store }: FeedbackFixture): void => {
    store.close();
    const database: Database = new Database(path);
    database.exec("DELETE FROM feedback_usage");
    database.close();
    const reopened: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      expect((): SubmitFeedbackResult => reopened.submitFeedback(feedbackCommand())).toThrow(
        "Feedback usage is invalid",
      );
    } finally {
      reopened.close();
    }
  });
});
