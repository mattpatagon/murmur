import { z } from "zod";

import {
  NOTICE_DEFAULT_TTL_HOURS,
  NOTICE_MAX_TTL_HOURS,
  NOTICE_MIN_TTL_HOURS,
  NoticeContent,
  NoticeId,
  NoticeKindSchema,
  NoticeStateSchema,
  ResolutionNote,
  SessionKeyInputSchema,
  SessionKey,
} from "./lifecycle-values.js";
import type {
  ListNoticesQuery,
  ListNoticesResult,
  Notice,
  NoticeCursor,
  PostNoticeCommand,
  ResolveNoticeCommand,
  WithdrawNoticeCommand,
} from "./notice-models.js";
import {
  AgentId,
  BranchName,
  IdempotencyKey,
  Instant,
  type RepositoryName,
} from "./value-objects.js";

const AgentIdTextSchema: z.ZodString = z.string().min(1).max(200);
const InstantTextSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const RepositoryNameTextSchema: z.ZodString = z
  .string()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u);
const NoticeCursorPayloadSchema: z.ZodTuple<[z.ZodISODateTime, z.ZodString]> = z.tuple([
  InstantTextSchema,
  z.string().uuid(),
]);

function decodeNoticeCursor(value: string): NoticeCursor {
  try {
    const decoded: string = Buffer.from(value, "base64url").toString("utf8");
    const payload: readonly [string, string, ...unknown[]] = NoticeCursorPayloadSchema.parse(
      JSON.parse(decoded),
    );
    return { createdAt: Instant.parse(payload[0]), noticeId: NoticeId.parse(payload[1]) };
  } catch (_error: unknown) {
    throw new Error("Invalid notice cursor");
  }
}

export function encodeNoticeCursor(cursor: NoticeCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt.toISOString(), cursor.noticeId.value]),
    "utf8",
  ).toString("base64url");
}

export type NoticeDto = {
  readonly branch: string | null;
  readonly content: string;
  readonly created_at: string;
  readonly creator_generation: number;
  readonly creator_id: string;
  readonly expires_at: string;
  readonly kind: "blocker" | "decision" | "handoff" | "ownership";
  readonly notice_id: string;
  readonly repository: string;
  readonly resolution_note: string | null;
  readonly resolved_at: string | null;
  readonly resolved_by_generation: number | null;
  readonly resolved_by_id: string | null;
  readonly state: "expired" | "open" | "resolved" | "withdrawn";
  readonly withdrawn_at: string | null;
  readonly withdrawn_by_generation: number | null;
  readonly withdrawn_by_id: string | null;
};

export const NoticeDtoSchema: z.ZodType<NoticeDto> = z.strictObject({
  branch: z.string().min(1).max(500).nullable(),
  content: z.string().min(1).max(100_000),
  created_at: InstantTextSchema,
  creator_generation: z.number().int().positive(),
  creator_id: AgentIdTextSchema,
  expires_at: InstantTextSchema,
  kind: NoticeKindSchema,
  notice_id: z.string().uuid(),
  repository: RepositoryNameTextSchema,
  resolution_note: z.string().min(1).max(2_000).nullable(),
  resolved_at: InstantTextSchema.nullable(),
  resolved_by_generation: z.number().int().positive().nullable(),
  resolved_by_id: AgentIdTextSchema.nullable(),
  state: NoticeStateSchema,
  withdrawn_at: InstantTextSchema.nullable(),
  withdrawn_by_generation: z.number().int().positive().nullable(),
  withdrawn_by_id: AgentIdTextSchema.nullable(),
});

export function toNoticeDto(notice: Notice): NoticeDto {
  return {
    branch: notice.branchName === null ? null : notice.branchName.value,
    content: notice.content.value,
    created_at: notice.createdAt.toISOString(),
    creator_generation: notice.creatorGeneration.value,
    creator_id: notice.creatorId.value,
    expires_at: notice.expiresAt.toISOString(),
    kind: notice.kind,
    notice_id: notice.noticeId.value,
    repository: notice.repositoryName.value,
    resolution_note: notice.resolutionNote === null ? null : notice.resolutionNote.value,
    resolved_at: notice.resolvedAt === null ? null : notice.resolvedAt.toISOString(),
    resolved_by_generation:
      notice.resolvedByGeneration === null ? null : notice.resolvedByGeneration.value,
    resolved_by_id: notice.resolvedById === null ? null : notice.resolvedById.value,
    state: notice.state,
    withdrawn_at: notice.withdrawnAt === null ? null : notice.withdrawnAt.toISOString(),
    withdrawn_by_generation:
      notice.withdrawnByGeneration === null ? null : notice.withdrawnByGeneration.value,
    withdrawn_by_id: notice.withdrawnById === null ? null : notice.withdrawnById.value,
  };
}

export type PostNoticeInput = {
  readonly actor_id: string;
  readonly branch?: string | undefined;
  readonly content: string;
  readonly expires_in_hours: number;
  readonly idempotency_key?: string | undefined;
  readonly kind: "blocker" | "decision" | "handoff" | "ownership";
  readonly repository?: string | undefined;
  readonly session_key?: string | undefined;
};

export const PostNoticeInputSchema: z.ZodType<PostNoticeInput> = z.strictObject({
  actor_id: AgentIdTextSchema,
  branch: z.string().trim().min(1).max(500).optional(),
  content: z.string().min(1).max(100_000),
  expires_in_hours: z
    .number()
    .int()
    .min(NOTICE_MIN_TTL_HOURS)
    .max(NOTICE_MAX_TTL_HOURS)
    .default(NOTICE_DEFAULT_TTL_HOURS),
  idempotency_key: z.string().min(1).max(200).optional(),
  kind: NoticeKindSchema,
  repository: RepositoryNameTextSchema.optional(),
  session_key: SessionKeyInputSchema.optional(),
});

export function postNoticeCommand(
  input: PostNoticeInput,
  repositoryName: RepositoryName,
): PostNoticeCommand {
  return {
    actorId: AgentId.parse(input.actor_id),
    branchName: input.branch === undefined ? null : BranchName.parse(input.branch),
    content: NoticeContent.parse(input.content),
    expiresInHours: input.expires_in_hours,
    idempotencyKey:
      input.idempotency_key === undefined ? null : IdempotencyKey.parse(input.idempotency_key),
    kind: NoticeKindSchema.parse(input.kind),
    repositoryName,
    sessionKey:
      input.session_key === undefined ? SessionKey.default() : SessionKey.parse(input.session_key),
  };
}

export type ListNoticesInput = {
  readonly actor_id: string;
  readonly branch?: string | undefined;
  readonly cursor?: string | undefined;
  readonly kind?: "blocker" | "decision" | "handoff" | "ownership" | undefined;
  readonly limit: number;
  readonly repository?: string | undefined;
  readonly session_key?: string | undefined;
  readonly state: "all" | "expired" | "open" | "resolved" | "withdrawn";
};

export const ListNoticesInputSchema: z.ZodType<ListNoticesInput> = z.strictObject({
  actor_id: AgentIdTextSchema,
  branch: z.string().trim().min(1).max(500).optional(),
  cursor: z.string().min(1).max(500).optional(),
  kind: NoticeKindSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  repository: RepositoryNameTextSchema.optional(),
  session_key: SessionKeyInputSchema.optional(),
  state: z.union([NoticeStateSchema, z.literal("all")]).default("open"),
});

export function listNoticesQuery(
  input: ListNoticesInput,
  repositoryName: RepositoryName,
): ListNoticesQuery {
  return {
    actorId: AgentId.parse(input.actor_id),
    branchName: input.branch === undefined ? null : BranchName.parse(input.branch),
    cursor: input.cursor === undefined ? null : decodeNoticeCursor(input.cursor),
    kind: input.kind === undefined ? null : NoticeKindSchema.parse(input.kind),
    limit: input.limit,
    repositoryName,
    sessionKey: input.session_key === undefined ? null : SessionKey.parse(input.session_key),
    state: input.state === "all" ? "all" : NoticeStateSchema.parse(input.state),
  };
}

type ChangeNoticeInput = {
  readonly actor_id: string;
  readonly notice_id: string;
  readonly repository?: string | undefined;
  readonly resolution_note: string;
  readonly session_key?: string | undefined;
};

const ChangeNoticeInputSchema: z.ZodType<ChangeNoticeInput> = z.strictObject({
  actor_id: AgentIdTextSchema,
  notice_id: z.string().uuid(),
  repository: RepositoryNameTextSchema.optional(),
  resolution_note: z.string().trim().min(1).max(2_000),
  session_key: SessionKeyInputSchema.optional(),
});

export type ResolveNoticeInput = ChangeNoticeInput;
export const ResolveNoticeInputSchema: z.ZodType<ResolveNoticeInput> = ChangeNoticeInputSchema;
export type WithdrawNoticeInput = ChangeNoticeInput;
export const WithdrawNoticeInputSchema: z.ZodType<WithdrawNoticeInput> = ChangeNoticeInputSchema;

function changeFields(
  input: ChangeNoticeInput,
  repositoryName: RepositoryName,
): {
  readonly actorId: AgentId;
  readonly noticeId: NoticeId;
  readonly repositoryName: RepositoryName;
  readonly resolutionNote: ResolutionNote;
  readonly sessionKey: SessionKey;
} {
  return {
    actorId: AgentId.parse(input.actor_id),
    noticeId: NoticeId.parse(input.notice_id),
    repositoryName,
    resolutionNote: ResolutionNote.parse(input.resolution_note),
    sessionKey:
      input.session_key === undefined ? SessionKey.default() : SessionKey.parse(input.session_key),
  };
}

export function resolveNoticeCommand(
  input: ResolveNoticeInput,
  repositoryName: RepositoryName,
): ResolveNoticeCommand {
  return changeFields(input, repositoryName);
}

export function withdrawNoticeCommand(
  input: WithdrawNoticeInput,
  repositoryName: RepositoryName,
): WithdrawNoticeCommand {
  return changeFields(input, repositoryName);
}

export type NoticeMutationOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly notice: NoticeDto;
};
export const NoticeMutationOutputSchema: z.ZodType<NoticeMutationOutput> = z.strictObject({
  duplicate: z.boolean(),
  notice: NoticeDtoSchema,
});

export type ListNoticesOutput = Record<string, unknown> & {
  readonly next_cursor: string | null;
  readonly notices: NoticeDto[];
};
export const ListNoticesOutputSchema: z.ZodType<ListNoticesOutput> = z.strictObject({
  next_cursor: z.string().min(1).max(500).nullable(),
  notices: z.array(NoticeDtoSchema),
});

export function toListNoticesOutput(result: ListNoticesResult): ListNoticesOutput {
  return {
    next_cursor: result.nextCursor === null ? null : encodeNoticeCursor(result.nextCursor),
    notices: result.notices.map(toNoticeDto),
  };
}
