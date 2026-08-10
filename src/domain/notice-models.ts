import type {
  AgentGeneration,
  NoticeContent,
  NoticeId,
  NoticeKind,
  NoticeState,
  ResolutionNote,
  SessionKey,
} from "./lifecycle-values.js";
import type {
  AgentId,
  BranchName,
  IdempotencyKey,
  Instant,
  RepositoryName,
} from "./value-objects.js";

export type Notice = {
  readonly branchName: BranchName | null;
  readonly content: NoticeContent;
  readonly createdAt: Instant;
  readonly creatorGeneration: AgentGeneration;
  readonly creatorId: AgentId;
  readonly expiresAt: Instant;
  readonly kind: NoticeKind;
  readonly noticeId: NoticeId;
  readonly repositoryName: RepositoryName;
  readonly resolutionNote: ResolutionNote | null;
  readonly resolvedAt: Instant | null;
  readonly resolvedByGeneration: AgentGeneration | null;
  readonly resolvedById: AgentId | null;
  readonly state: NoticeState;
  readonly withdrawnAt: Instant | null;
  readonly withdrawnByGeneration: AgentGeneration | null;
  readonly withdrawnById: AgentId | null;
};

export type PostNoticeCommand = {
  readonly actorId: AgentId;
  readonly branchName: BranchName | null;
  readonly content: NoticeContent;
  readonly expiresInHours: number;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly kind: NoticeKind;
  readonly repositoryName: RepositoryName;
  readonly sessionKey: SessionKey;
};

export type PostNoticeResult = {
  readonly duplicate: boolean;
  readonly notice: Notice;
};

export type ListNoticesQuery = {
  readonly actorId: AgentId;
  readonly branchName: BranchName | null;
  readonly cursor: NoticeCursor | null;
  readonly kind: NoticeKind | null;
  readonly limit: number;
  readonly repositoryName: RepositoryName;
  readonly sessionKey: SessionKey | null;
  readonly state: NoticeState | "all";
};

export type NoticeCursor = {
  readonly createdAt: Instant;
  readonly noticeId: NoticeId;
};

export type ListNoticesResult = {
  readonly nextCursor: NoticeCursor | null;
  readonly notices: readonly Notice[];
};

export type ResolveNoticeCommand = {
  readonly actorId: AgentId;
  readonly noticeId: NoticeId;
  readonly repositoryName: RepositoryName;
  readonly resolutionNote: ResolutionNote;
  readonly sessionKey: SessionKey;
};

export type ResolveNoticeResult = {
  readonly alreadyResolved: boolean;
  readonly notice: Notice;
};

export type WithdrawNoticeCommand = {
  readonly actorId: AgentId;
  readonly noticeId: NoticeId;
  readonly repositoryName: RepositoryName;
  readonly resolutionNote: ResolutionNote;
  readonly sessionKey: SessionKey;
};

export type WithdrawNoticeResult = {
  readonly alreadyWithdrawn: boolean;
  readonly notice: Notice;
};
