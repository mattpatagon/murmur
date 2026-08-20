import type { Database } from "bun:sqlite";

import { FeedbackCapacityError, FeedbackIdempotencyConflictError } from "../domain/errors.js";
import {
  FeedbackId,
  MAX_FEEDBACK_CONTENT_BYTES,
  MAX_RETAINED_FEEDBACK_SUBMISSIONS,
  type SubmitFeedbackCommand,
  type SubmitFeedbackResult,
} from "../domain/feedback-models.js";
import type { Agent } from "../domain/models.js";
import type { Instant } from "../domain/value-objects.js";
import { mapFeedbackRow, type FeedbackRow, FeedbackRowSchema } from "./feedback-rows.js";
import { renewSqliteSession } from "./sqlite-agent-lifecycle-store.js";

function feedbackRow(database: Database, feedbackId: FeedbackId): FeedbackRow | null {
  const raw: unknown = database
    .query<unknown, [string]>("SELECT * FROM feedback_submissions WHERE feedback_id = ?")
    .get(feedbackId.value);
  return raw === null ? null : FeedbackRowSchema.parse(raw);
}

function sameSubmission(row: FeedbackRow, command: SubmitFeedbackCommand): boolean {
  return (
    row.submission_type === command.type &&
    row.title === command.title.value &&
    row.description === command.description.value &&
    row.repository_name === command.repositoryName.value &&
    row.branch_name === command.branchName.value &&
    row.client_name === command.client.value
  );
}

function existingSubmission(
  database: Database,
  command: SubmitFeedbackCommand,
): SubmitFeedbackResult | null {
  if (command.idempotencyKey === null) return null;
  const raw: unknown = database
    .query<unknown, [string, string]>(`
      SELECT * FROM feedback_submissions
      WHERE reporter_id = ? AND idempotency_key = ?
    `)
    .get(command.reporterId.value, command.idempotencyKey.value);
  if (raw === null) return null;
  const row: FeedbackRow = FeedbackRowSchema.parse(raw);
  if (!sameSubmission(row, command)) {
    throw new FeedbackIdempotencyConflictError(command.idempotencyKey.value);
  }
  return { duplicate: true, submission: mapFeedbackRow(row) };
}

function reserveFeedbackCapacity(database: Database, title: string, description: string): void {
  const addedBytes: number =
    Buffer.byteLength(title, "utf8") + Buffer.byteLength(description, "utf8");
  const changes: number = database
    .query<unknown, [number, number, number, number]>(`
      UPDATE feedback_usage
      SET
        submission_count = submission_count + 1,
        content_bytes = content_bytes + ?
      WHERE singleton = 1
        AND submission_count < ?
        AND content_bytes + ? <= ?
    `)
    .run(
      addedBytes,
      MAX_RETAINED_FEEDBACK_SUBMISSIONS,
      addedBytes,
      MAX_FEEDBACK_CONTENT_BYTES,
    ).changes;
  if (changes === 1) return;
  const usage: unknown = database
    .query<unknown, []>(`
      SELECT submission_count, content_bytes FROM feedback_usage WHERE singleton = 1
    `)
    .get();
  if (usage === null) {
    throw new Error("Feedback usage is invalid");
  }
  throw new FeedbackCapacityError();
}

export function submitSqliteFeedback(
  database: Database,
  command: SubmitFeedbackCommand,
  now: Instant,
): SubmitFeedbackResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing: SubmitFeedbackResult | null = existingSubmission(database, command);
    if (existing !== null) {
      database.exec("COMMIT");
      return existing;
    }
    const reporter: Agent = renewSqliteSession(
      database,
      command.reporterId,
      command.sessionKey,
      now,
      true,
    );
    reserveFeedbackCapacity(database, command.title.value, command.description.value);
    const feedbackId: FeedbackId = FeedbackId.generate();
    database
      .query<
        unknown,
        [
          string,
          string,
          string,
          number,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string,
        ]
      >(`
        INSERT INTO feedback_submissions(
          feedback_id, submission_type, reporter_id, reporter_generation,
          repository_name, branch_name, client_name, title, description,
          idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        feedbackId.value,
        command.type,
        command.reporterId.value,
        reporter.generation.value,
        command.repositoryName.value,
        command.branchName.value,
        command.client.value,
        command.title.value,
        command.description.value,
        command.idempotencyKey === null ? null : command.idempotencyKey.value,
        now.toISOString(),
      );
    const row: FeedbackRow | null = feedbackRow(database, feedbackId);
    if (row === null) throw new Error("Inserted feedback submission could not be read back");
    const result: SubmitFeedbackResult = {
      duplicate: false,
      submission: mapFeedbackRow(row),
    };
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
