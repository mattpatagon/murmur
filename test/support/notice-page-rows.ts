import type { ListNoticesQuery } from "../../src/domain/notice-models.js";
import { AgentId, Instant, RepositoryName } from "../../src/domain/value-objects.js";
import type { NoticeRow } from "../../src/storage/notice-rows.js";

export const NOTICE_PAGE_NOW: Instant = Instant.parse("2030-01-01T00:00:00.000Z");

export function noticePageQuery(): ListNoticesQuery {
  return {
    actorId: AgentId.parse("reader"),
    branchName: null,
    cursor: null,
    kind: null,
    limit: 500,
    repositoryName: RepositoryName.parse("audit/notices"),
    sessionKey: null,
    state: "all",
  };
}

export function noticePageRow(index: number, content: string): NoticeRow {
  return {
    notice_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    content,
    branch_name: null,
    created_at: NOTICE_PAGE_NOW.toISOString(),
    creator_generation: 1,
    creator_id: "reader",
    expires_at: "2030-01-02T00:00:00.000Z",
    idempotency_key: null,
    kind: "handoff",
    repository_name: "audit/notices",
    resolution_note: null,
    resolved_at: null,
    resolved_by_generation: null,
    resolved_by_id: null,
    withdrawn_at: null,
    withdrawn_by_generation: null,
    withdrawn_by_id: null,
  };
}
