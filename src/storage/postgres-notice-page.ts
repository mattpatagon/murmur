import type { TransactionSql } from "postgres";

import type { ListNoticesQuery, ListNoticesResult } from "../domain/notice-models.js";
import type { Instant, TenantId } from "../domain/value-objects.js";
import {
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";
import {
  MAX_NOTICE_PAGE_BYTES,
  NOTICE_PAGE_ROW_BYTES,
  NOTICE_PAGE_TEXT_MULTIPLIER,
  parsePostgresNoticePage,
} from "./notice-page-budget.js";

export async function readPostgresNoticePage(
  transaction: TransactionSql,
  tenantId: TenantId,
  query: ListNoticesQuery,
  now: Instant,
): Promise<ListNoticesResult> {
  const branch: string | null = query.branchName === null ? null : query.branchName.value;
  const created: string | null =
    query.cursor === null ? null : query.cursor.createdAt.toISOString();
  const cursorId: string | null = query.cursor === null ? null : query.cursor.noticeId.value;
  const reservation: MaterializationReservation =
    reserveMaterializationBytes(MAX_NOTICE_PAGE_BYTES);
  try {
    const raw: unknown = await transaction`
      WITH candidates AS MATERIALIZED (
        SELECT notice_id, created_at,
          ${NOTICE_PAGE_TEXT_MULTIPLIER}::bigint * (octet_length(content)
            + COALESCE(octet_length(resolution_note), 0)) + ${NOTICE_PAGE_ROW_BYTES}::bigint AS estimated_bytes
        FROM murmur.notices
        WHERE tenant_id = ${tenantId.value}::uuid
          AND repository_name = ${query.repositoryName.value}
          AND (${branch}::text IS NULL OR branch_name = ${branch})
          AND (${query.kind}::text IS NULL OR kind = ${query.kind})
          AND (${query.state} = 'all'
            OR (${query.state} = 'resolved' AND resolved_at IS NOT NULL)
            OR (${query.state} = 'withdrawn' AND withdrawn_at IS NOT NULL)
            OR (${query.state} = 'open' AND resolved_at IS NULL AND withdrawn_at IS NULL
              AND expires_at > ${now.toISOString()}::timestamptz)
            OR (${query.state} = 'expired' AND resolved_at IS NULL AND withdrawn_at IS NULL
              AND expires_at <= ${now.toISOString()}::timestamptz))
          AND (${created}::timestamptz IS NULL OR created_at < ${created}::timestamptz
            OR (created_at = ${created}::timestamptz AND notice_id > ${cursorId}::uuid))
        ORDER BY created_at DESC, notice_id ASC LIMIT ${query.limit + 1}
      ), metered AS (
        SELECT notice_id, created_at,
          ROW_NUMBER() OVER (ORDER BY created_at DESC, notice_id ASC) AS page_row,
          SUM(estimated_bytes) OVER (ORDER BY created_at DESC, notice_id ASC ROWS UNBOUNDED PRECEDING)
            AS estimated_page_bytes
        FROM candidates
      )
      SELECT CASE WHEN metered.page_row <= ${query.limit}
          AND metered.estimated_page_bytes <= ${MAX_NOTICE_PAGE_BYTES}
        THEN jsonb_build_object(
          'notice_id', notice.notice_id::text, 'kind', notice.kind,
          'creator_id', notice.creator_id, 'creator_generation', notice.creator_generation,
          'repository_name', notice.repository_name, 'branch_name', notice.branch_name,
          'content', notice.content, 'idempotency_key', notice.idempotency_key,
          'created_at', to_char(notice.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'expires_at', to_char(notice.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'resolved_by_id', notice.resolved_by_id, 'resolved_by_generation', notice.resolved_by_generation,
          'resolved_at', to_char(notice.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'withdrawn_by_id', notice.withdrawn_by_id, 'withdrawn_by_generation', notice.withdrawn_by_generation,
          'withdrawn_at', to_char(notice.withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'resolution_note', notice.resolution_note
        )::text ELSE NULL END AS row_json,
        CASE WHEN metered.page_row <= ${query.limit}
          AND metered.estimated_page_bytes <= ${MAX_NOTICE_PAGE_BYTES}
        THEN metered.estimated_page_bytes ELSE 0 END AS estimated_page_bytes
      FROM metered
      LEFT JOIN murmur.notices AS notice
        ON metered.page_row <= ${query.limit}
        AND metered.estimated_page_bytes <= ${MAX_NOTICE_PAGE_BYTES}
        AND notice.tenant_id = ${tenantId.value}::uuid AND notice.notice_id = metered.notice_id
      ORDER BY metered.created_at DESC, metered.notice_id ASC
    `;
    const page: { readonly bytes: number; readonly result: ListNoticesResult } =
      parsePostgresNoticePage(raw, now);
    reservation.settle(page.bytes);
    return page.result;
  } catch (error: unknown) {
    reservation.fail();
    throw error;
  }
}
