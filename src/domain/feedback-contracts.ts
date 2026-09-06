import { z } from "zod";

import { type AgentClientName, AgentClientNameSchema } from "./client-provenance.js";
import {
  type MessageContextDto,
  MessageContextDtoSchema,
  nullableIdempotencyKey,
} from "./contracts.js";
import {
  FeedbackDescription,
  type FeedbackSubmission,
  FeedbackTitle,
  FeedbackTypeSchema,
  type SubmitFeedbackCommand,
} from "./feedback-models.js";
import { SessionKey, SessionKeyInputSchema } from "./lifecycle-values.js";
import { AgentId } from "./value-objects.js";

const AgentIdTextSchema: z.ZodString = z.string().min(1).max(200);
const InstantTextSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const RequiredFeedbackContextSchema: z.ZodType<RequiredFeedbackContext> = z.strictObject({
  branch: z.string().trim().min(1).max(500),
  client: AgentClientNameSchema,
  repository: z
    .string()
    .min(3)
    .max(500)
    .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u),
});

export type SubmitFeedbackInput = {
  readonly context?: MessageContextDto | undefined;
  readonly description: string;
  readonly idempotency_key?: string | undefined;
  readonly reporter_id: string;
  readonly session_key?: string | undefined;
  readonly title: string;
  readonly type: "feature_request" | "issue";
};

export const SubmitFeedbackInputSchema: z.ZodType<SubmitFeedbackInput> = z.strictObject({
  context: MessageContextDtoSchema.optional(),
  description: z.string().trim().min(1).max(100_000),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  reporter_id: AgentIdTextSchema,
  session_key: SessionKeyInputSchema.optional(),
  title: z.string().trim().min(1).max(200),
  type: FeedbackTypeSchema,
});

export type RequiredFeedbackContext = {
  readonly branch: string;
  readonly client: AgentClientName;
  readonly repository: string;
};

export type FeedbackSubmissionDto = {
  readonly context: RequiredFeedbackContext;
  readonly created_at: string;
  readonly description: string;
  readonly reporter_generation: number;
  readonly reporter_id: string;
  readonly submission_id: string;
  readonly title: string;
  readonly type: "feature_request" | "issue";
};

export const FeedbackSubmissionDtoSchema: z.ZodType<FeedbackSubmissionDto> = z.strictObject({
  context: RequiredFeedbackContextSchema,
  created_at: InstantTextSchema,
  description: z.string().trim().min(1).max(100_000),
  reporter_generation: z.number().int().positive().safe(),
  reporter_id: AgentIdTextSchema,
  submission_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  type: FeedbackTypeSchema,
});

export type SubmitFeedbackOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly status: "stored";
  readonly submission: FeedbackSubmissionDto;
};

export const SubmitFeedbackOutputSchema: z.ZodType<SubmitFeedbackOutput> = z.strictObject({
  duplicate: z.boolean(),
  status: z.literal("stored"),
  submission: FeedbackSubmissionDtoSchema,
});

export function submitFeedbackCommand(
  input: SubmitFeedbackInput,
  context: {
    readonly branchName: SubmitFeedbackCommand["branchName"];
    readonly client: SubmitFeedbackCommand["client"];
    readonly repositoryName: SubmitFeedbackCommand["repositoryName"];
  },
): SubmitFeedbackCommand {
  return {
    ...context,
    description: FeedbackDescription.parse(input.description),
    idempotencyKey: nullableIdempotencyKey(input.idempotency_key),
    reporterId: AgentId.parse(input.reporter_id),
    sessionKey:
      input.session_key === undefined ? SessionKey.default() : SessionKey.parse(input.session_key),
    title: FeedbackTitle.parse(input.title),
    type: FeedbackTypeSchema.parse(input.type),
  };
}

export function toFeedbackSubmissionDto(submission: FeedbackSubmission): FeedbackSubmissionDto {
  return FeedbackSubmissionDtoSchema.parse({
    context: {
      branch: submission.branchName.value,
      client: submission.client.value,
      repository: submission.repositoryName.value,
    },
    created_at: submission.createdAt.toISOString(),
    description: submission.description.value,
    reporter_generation: submission.reporterGeneration.value,
    reporter_id: submission.reporterId.value,
    submission_id: submission.feedbackId.value,
    title: submission.title.value,
    type: submission.type,
  });
}
