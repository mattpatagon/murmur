import type { Database } from "bun:sqlite";

import { StorageCorruptionError } from "../domain/errors.js";
import type { ListNoticesQuery, ListNoticesResult, Notice } from "../domain/notice-models.js";
import type { Instant } from "../domain/value-objects.js";
import {
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";
import {
  fitNoticePrefix,
  MAX_NOTICE_PAGE_BYTES,
  NOTICE_PAGE_ROW_BYTES,
  NOTICE_PAGE_TEXT_MULTIPLIER,
  type NoticePrefix,
  noticePageResult,
} from "./notice-page-budget.js";
import { mapNoticeRow } from "./notice-rows.js";

type NoticeBindings = [
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
];

export function readSqliteNoticePage(
  database: Database,
  query: ListNoticesQuery,
  now: Instant,
): ListNoticesResult {
  const branch: string | null = query.branchName === null ? null : query.branchName.value;
  const created: string | null =
    query.cursor === null ? null : query.cursor.createdAt.toISOString();
  const cursorId: string | null = query.cursor === null ? null : query.cursor.noticeId.value;
  const bindings: NoticeBindings = [
    query.repositoryName.value,
    branch,
    branch,
    query.kind,
    query.kind,
    query.state,
    query.state,
    query.state,
    query.state,
    now.toISOString(),
    query.state,
    now.toISOString(),
    created,
    created,
    created,
    cursorId,
  ];
  const candidates: string = `FROM notices
    WHERE repository_name = ?
      AND (? IS NULL OR branch_name = ?) AND (? IS NULL OR kind = ?)
      AND (? = 'all'
        OR (? = 'resolved' AND resolved_at IS NOT NULL)
        OR (? = 'withdrawn' AND withdrawn_at IS NOT NULL)
        OR (? = 'open' AND resolved_at IS NULL AND withdrawn_at IS NULL AND expires_at > ?)
        OR (? = 'expired' AND resolved_at IS NULL AND withdrawn_at IS NULL AND expires_at <= ?))
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND notice_id > ?))
    ORDER BY created_at DESC, notice_id ASC LIMIT ?`;
  const reservation: MaterializationReservation =
    reserveMaterializationBytes(MAX_NOTICE_PAGE_BYTES);
  try {
    const page: { readonly bytes: number; readonly result: ListNoticesResult } =
      database.transaction((): { readonly bytes: number; readonly result: ListNoticesResult } => {
        const rawCandidates: unknown[] = database
          .query<unknown, [number, number, ...NoticeBindings, number]>(`
          SELECT notice_id, ? * (length(CAST(content AS BLOB))
            + COALESCE(length(CAST(resolution_note AS BLOB)), 0)) + ? AS estimated_bytes
          ${candidates}
        `)
          .all(NOTICE_PAGE_TEXT_MULTIPLIER, NOTICE_PAGE_ROW_BYTES, ...bindings, query.limit + 1);
        const prefix: NoticePrefix = fitNoticePrefix(rawCandidates, query.limit);
        const rows: unknown[] =
          prefix.count === 0
            ? []
            : database
                .query<unknown, [...NoticeBindings, number]>(`SELECT * ${candidates}`)
                .all(...bindings, prefix.count);
        if (rows.length !== prefix.count) {
          throw new StorageCorruptionError(
            "notice page accounting",
            new Error("Prefix row count changed"),
          );
        }
        const notices: Notice[] = rows.map((row: unknown): Notice => mapNoticeRow(row, now));
        return { bytes: prefix.bytes, result: noticePageResult(notices, prefix.hasMore) };
      })();
    reservation.settle(page.bytes);
    return page.result;
  } catch (error: unknown) {
    reservation.fail();
    throw error;
  }
}
