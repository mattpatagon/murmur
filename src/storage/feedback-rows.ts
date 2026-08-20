import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import {
  FeedbackDescription,
  FeedbackId,
  type FeedbackSubmission,
  FeedbackTitle,
  FeedbackTypeSchema,
} from "../domain/feedback-models.js";
import { AgentGeneration } from "../domain/lifecycle-values.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  Instant,
  RepositoryName,
} from "../domain/value-objects.js";

export type FeedbackRow = {
  readonly branch_name: string;
  readonly client_name: string;
  readonly created_at: string;
  readonly description: string;
  readonly feedback_id: string;
  readonly idempotency_key: string | null;
  readonly reporter_generation: number;
  readonly reporter_id: string;
  readonly repository_name: string;
  readonly submission_type: string;
  readonly title: string;
};

const SafeIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)))
  .transform((value: bigint | number | string): number => Number(value));

export const FeedbackRowSchema: z.ZodType<FeedbackRow> = z.strictObject({
  branch_name: z.string(),
  client_name: z.string(),
  created_at: z.string(),
  description: z.string(),
  feedback_id: z.string(),
  idempotency_key: z.string().nullable(),
  reporter_generation: SafeIntegerSchema.pipe(z.number().positive()),
  reporter_id: z.string(),
  repository_name: z.string(),
  submission_type: z.string(),
  title: z.string(),
});

export function mapFeedbackRow(input: unknown): FeedbackSubmission {
  try {
    const row: FeedbackRow = FeedbackRowSchema.parse(input);
    return {
      branchName: BranchName.parse(row.branch_name),
      client: AgentClient.parse(row.client_name),
      createdAt: Instant.parse(row.created_at),
      description: FeedbackDescription.parse(row.description),
      feedbackId: FeedbackId.parse(row.feedback_id),
      reporterGeneration: AgentGeneration.parse(row.reporter_generation),
      reporterId: AgentId.parse(row.reporter_id),
      repositoryName: RepositoryName.parse(row.repository_name),
      title: FeedbackTitle.parse(row.title),
      type: FeedbackTypeSchema.parse(row.submission_type),
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("feedback submission", error);
  }
}
