import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { FeedbackIdempotencyConflictError } from "../domain/errors.js";
import {
  FeedbackId,
  type SubmitFeedbackCommand,
  type SubmitFeedbackResult,
} from "../domain/feedback-models.js";
import type { Agent } from "../domain/models.js";
import type { Instant, TenantId } from "../domain/value-objects.js";
import { mapFeedbackRow, type FeedbackRow, FeedbackRowSchema } from "./feedback-rows.js";
import { renewPostgresSessionInTransaction } from "./postgres-agent-lifecycle-store.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

async function feedbackRow(
  transaction: TransactionSql,
  tenantId: TenantId,
  feedbackId: FeedbackId,
): Promise<FeedbackRow | null> {
  const raw: unknown = await transaction`
    SELECT feedback_id::text AS feedback_id, submission_type, reporter_id,
      reporter_generation, repository_name, branch_name, client_name, title, description,
      idempotency_key,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM murmur.feedback_submissions
    WHERE tenant_id = ${tenantId.value}::uuid AND feedback_id = ${feedbackId.value}::uuid
  `;
  const rows: FeedbackRow[] = z.array(FeedbackRowSchema).parse(raw);
  return rows[0] ?? null;
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

async function existingSubmission(
  transaction: TransactionSql,
  tenantId: TenantId,
  command: SubmitFeedbackCommand,
): Promise<SubmitFeedbackResult | null> {
  if (command.idempotencyKey === null) return null;
  const raw: unknown = await transaction`
    SELECT feedback_id::text AS feedback_id FROM murmur.feedback_submissions
    WHERE tenant_id = ${tenantId.value}::uuid
      AND reporter_id = ${command.reporterId.value}
      AND idempotency_key = ${command.idempotencyKey.value}
  `;
  const ids: { readonly feedback_id: string }[] = z
    .array(z.strictObject({ feedback_id: z.string().uuid() }))
    .parse(raw);
  const idRow: { readonly feedback_id: string } | undefined = ids[0];
  if (idRow === undefined) return null;
  const row: FeedbackRow | null = await feedbackRow(
    transaction,
    tenantId,
    FeedbackId.parse(idRow.feedback_id),
  );
  if (row === null) throw new Error("Idempotent feedback submission disappeared");
  if (!sameSubmission(row, command)) {
    throw new FeedbackIdempotencyConflictError(command.idempotencyKey.value);
  }
  return { duplicate: true, submission: mapFeedbackRow(row) };
}

export async function submitPostgresFeedback(
  database: Sql,
  tenantId: TenantId,
  command: SubmitFeedbackCommand,
  now: Instant,
): Promise<SubmitFeedbackResult> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<SubmitFeedbackResult> => {
      await setPostgresTenantContext(transaction, tenantId);
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        command.reporterId.value,
      ]);
      const existing: SubmitFeedbackResult | null = await existingSubmission(
        transaction,
        tenantId,
        command,
      );
      if (existing !== null) return existing;
      const reporter: Agent = await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        command.reporterId,
        command.sessionKey,
        now,
        true,
      );
      const feedbackId: FeedbackId = FeedbackId.generate();
      await transaction`
      INSERT INTO murmur.feedback_submissions(
        tenant_id, feedback_id, submission_type, reporter_id, reporter_generation,
        repository_name, branch_name, client_name, title, description,
        idempotency_key, created_at
      ) VALUES (
        ${tenantId.value}::uuid, ${feedbackId.value}::uuid, ${command.type},
        ${command.reporterId.value}, ${reporter.generation.value},
        ${command.repositoryName.value}, ${command.branchName.value}, ${command.client.value},
        ${command.title.value}, ${command.description.value},
        ${command.idempotencyKey === null ? null : command.idempotencyKey.value},
        ${now.toISOString()}::timestamptz
      )
    `;
      const row: FeedbackRow | null = await feedbackRow(transaction, tenantId, feedbackId);
      if (row === null) throw new Error("Inserted feedback submission could not be read back");
      return { duplicate: false, submission: mapFeedbackRow(row) };
    },
  );
}
