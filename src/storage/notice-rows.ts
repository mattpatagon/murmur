import { z } from "zod";

import {
  AgentGeneration,
  NoticeContent,
  NoticeId,
  NoticeKindSchema,
  type NoticeState,
  ResolutionNote,
} from "../domain/lifecycle-values.js";
import type { Notice } from "../domain/notice-models.js";
import { AgentId, BranchName, Instant, RepositoryName } from "../domain/value-objects.js";
import { StorageCorruptionError } from "../domain/errors.js";

export type NoticeRow = {
  readonly branch_name: string | null;
  readonly content: string;
  readonly created_at: string;
  readonly creator_generation: number;
  readonly creator_id: string;
  readonly expires_at: string;
  readonly idempotency_key: string | null;
  readonly kind: string;
  readonly notice_id: string;
  readonly repository_name: string;
  readonly resolution_note: string | null;
  readonly resolved_at: string | null;
  readonly resolved_by_generation: number | null;
  readonly resolved_by_id: string | null;
  readonly withdrawn_at: string | null;
  readonly withdrawn_by_generation: number | null;
  readonly withdrawn_by_id: string | null;
};

const SafeIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)))
  .transform((value: bigint | number | string): number => Number(value));

export const NoticeRowSchema: z.ZodType<NoticeRow> = z.strictObject({
  branch_name: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  creator_generation: SafeIntegerSchema.pipe(z.number().positive()),
  creator_id: z.string(),
  expires_at: z.string(),
  idempotency_key: z.string().nullable(),
  kind: z.string(),
  notice_id: z.string(),
  repository_name: z.string(),
  resolution_note: z.string().nullable(),
  resolved_at: z.string().nullable(),
  resolved_by_generation: SafeIntegerSchema.pipe(z.number().positive()).nullable(),
  resolved_by_id: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  withdrawn_by_generation: SafeIntegerSchema.pipe(z.number().positive()).nullable(),
  withdrawn_by_id: z.string().nullable(),
});

function noticeState(row: NoticeRow, now: Instant): NoticeState {
  if (row.resolved_at !== null) return "resolved";
  if (row.withdrawn_at !== null) return "withdrawn";
  if (!Instant.parse(row.expires_at).isAfter(now)) return "expired";
  return "open";
}

export function mapNoticeRow(input: unknown, now: Instant): Notice {
  try {
    const row: NoticeRow = NoticeRowSchema.parse(input);
    return {
      branchName: row.branch_name === null ? null : BranchName.parse(row.branch_name),
      content: NoticeContent.parse(row.content),
      createdAt: Instant.parse(row.created_at),
      creatorGeneration: AgentGeneration.parse(row.creator_generation),
      creatorId: AgentId.parse(row.creator_id),
      expiresAt: Instant.parse(row.expires_at),
      kind: NoticeKindSchema.parse(row.kind),
      noticeId: NoticeId.parse(row.notice_id),
      repositoryName: RepositoryName.parse(row.repository_name),
      resolutionNote:
        row.resolution_note === null ? null : ResolutionNote.parse(row.resolution_note),
      resolvedAt: row.resolved_at === null ? null : Instant.parse(row.resolved_at),
      resolvedByGeneration:
        row.resolved_by_generation === null
          ? null
          : AgentGeneration.parse(row.resolved_by_generation),
      resolvedById: row.resolved_by_id === null ? null : AgentId.parse(row.resolved_by_id),
      state: noticeState(row, now),
      withdrawnAt: row.withdrawn_at === null ? null : Instant.parse(row.withdrawn_at),
      withdrawnByGeneration:
        row.withdrawn_by_generation === null
          ? null
          : AgentGeneration.parse(row.withdrawn_by_generation),
      withdrawnById: row.withdrawn_by_id === null ? null : AgentId.parse(row.withdrawn_by_id),
    };
  } catch (error: unknown) {
    throw new StorageCorruptionError("notice", error);
  }
}
