import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AgentGeneration, SessionKey } from "./lifecycle-values.js";
import type {
  AgentClient,
  AgentId,
  BranchName,
  IdempotencyKey,
  Instant,
  RepositoryName,
} from "./value-objects.js";

const FeedbackIdValueSchema: z.ZodString = z.string().uuid();
const FeedbackTitleValueSchema: z.ZodString = z.string().trim().min(1).max(200);
const FeedbackDescriptionValueSchema: z.ZodString = z.string().trim().min(1).max(100_000);

export const MAX_RETAINED_FEEDBACK_SUBMISSIONS: number = 10_000;
export const MAX_FEEDBACK_CONTENT_BYTES: number = 64 * 1024 * 1024;

export const FeedbackTypeSchema: z.ZodEnum<{
  feature_request: "feature_request";
  issue: "issue";
}> = z.enum(["issue", "feature_request"]);
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>;

export class FeedbackId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): FeedbackId {
    return new FeedbackId(FeedbackIdValueSchema.parse(input));
  }

  public static generate(): FeedbackId {
    return FeedbackId.parse(randomUUID());
  }
}

export class FeedbackTitle {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): FeedbackTitle {
    return new FeedbackTitle(FeedbackTitleValueSchema.parse(input));
  }
}

export class FeedbackDescription {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): FeedbackDescription {
    return new FeedbackDescription(FeedbackDescriptionValueSchema.parse(input));
  }
}

export type FeedbackSubmission = {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly createdAt: Instant;
  readonly description: FeedbackDescription;
  readonly feedbackId: FeedbackId;
  readonly reporterGeneration: AgentGeneration;
  readonly reporterId: AgentId;
  readonly repositoryName: RepositoryName;
  readonly title: FeedbackTitle;
  readonly type: FeedbackType;
};

export type SubmitFeedbackCommand = {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly description: FeedbackDescription;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly reporterId: AgentId;
  readonly repositoryName: RepositoryName;
  readonly sessionKey: SessionKey;
  readonly title: FeedbackTitle;
  readonly type: FeedbackType;
};

export type SubmitFeedbackResult = {
  readonly duplicate: boolean;
  readonly submission: FeedbackSubmission;
};
