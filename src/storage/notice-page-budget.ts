import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import type { ListNoticesResult, Notice } from "../domain/notice-models.js";
import type { Instant } from "../domain/value-objects.js";
import { mapNoticeRow, type NoticeRow, NoticeRowSchema } from "./notice-rows.js";

export const MAX_NOTICE_PAGE_BYTES: number = 8 * 1024 * 1024;
export const NOTICE_PAGE_TEXT_MULTIPLIER: number = 13;
export const NOTICE_PAGE_ROW_BYTES: number = 16 * 1024;

export class NoticePageCapacityError extends Error {
  public constructor() {
    super("Stored notice exceeds the safe page size; contact the service owner.");
    this.name = NoticePageCapacityError.name;
  }
}

const ByteCountSchema: z.ZodType<number> = z
  .union([z.number(), z.bigint(), z.string().regex(/^[0-9]{1,16}$/u)])
  .transform((value: bigint | number | string): number => Number(value))
  .pipe(z.number().int().nonnegative().safe());

export type NoticePrefix = {
  readonly bytes: number;
  readonly count: number;
  readonly hasMore: boolean;
};

export function fitNoticePrefix(raw: unknown, limit: number): NoticePrefix {
  const candidates: { readonly estimated_bytes: number }[] = z
    .array(
      z.object({ estimated_bytes: ByteCountSchema.pipe(z.number().min(NOTICE_PAGE_ROW_BYTES)) }),
    )
    .max(501)
    .parse(raw);
  let bytes: number = 0;
  let count: number = 0;
  for (const candidate of candidates) {
    if (count === limit || candidate.estimated_bytes > MAX_NOTICE_PAGE_BYTES - bytes) break;
    bytes += candidate.estimated_bytes;
    count += 1;
  }
  if (count === 0 && candidates.length > 0) throw new NoticePageCapacityError();
  return { bytes, count, hasMore: count < candidates.length };
}

export function noticePageResult(notices: readonly Notice[], hasMore: boolean): ListNoticesResult {
  const last: Notice | undefined = notices.at(-1);
  if (hasMore && last === undefined) throw new NoticePageCapacityError();
  return {
    notices,
    nextCursor:
      hasMore && last !== undefined ? { createdAt: last.createdAt, noticeId: last.noticeId } : null,
  };
}

type BudgetedNoticeRow = {
  readonly estimated_page_bytes: number;
  readonly row_json: string | null;
};
const BudgetedNoticeRowSchema: z.ZodType<BudgetedNoticeRow> = z.strictObject({
  estimated_page_bytes: ByteCountSchema.pipe(z.number().max(MAX_NOTICE_PAGE_BYTES)),
  row_json: z.string().nullable(),
});

export function parsePostgresNoticePage(
  raw: unknown,
  now: Instant,
): { readonly bytes: number; readonly result: ListNoticesResult } {
  const rows: BudgetedNoticeRow[] = z.array(BudgetedNoticeRowSchema).max(501).parse(raw);
  const notices: Notice[] = [];
  const ids: Set<string> = new Set<string>();
  let bytes: number = 0;
  let hasMore: boolean = false;
  for (const row of rows) {
    if (row.row_json === null) {
      if (row.estimated_page_bytes !== 0) {
        throw new StorageCorruptionError(
          "notice page accounting",
          new Error("Invalid suffix cost"),
        );
      }
      hasMore = true;
      continue;
    }
    if (hasMore || row.estimated_page_bytes < bytes + NOTICE_PAGE_ROW_BYTES) {
      throw new StorageCorruptionError("notice page accounting", new Error("Invalid prefix order"));
    }
    let value: unknown;
    try {
      value = JSON.parse(row.row_json);
    } catch (error: unknown) {
      throw new StorageCorruptionError("notice page payload", error);
    }
    const notice: Notice = mapNoticeRow(value, now);
    const payload: NoticeRow = NoticeRowSchema.parse(value);
    // SQL measures stored text, including whitespace trimmed by the resolution-note value object.
    const resolutionBytes: number =
      payload.resolution_note === null ? 0 : Buffer.byteLength(payload.resolution_note, "utf8");
    const rowBytes: number =
      NOTICE_PAGE_ROW_BYTES +
      NOTICE_PAGE_TEXT_MULTIPLIER * (Buffer.byteLength(payload.content, "utf8") + resolutionBytes);
    const id: string = notice.noticeId.value.toLowerCase();
    if (row.estimated_page_bytes !== bytes + rowBytes || ids.has(id)) {
      throw new StorageCorruptionError(
        "notice page accounting",
        new Error("Invalid payload cost or identity"),
      );
    }
    ids.add(id);
    notices.push(notice);
    bytes = row.estimated_page_bytes;
  }
  return { bytes, result: noticePageResult(notices, hasMore) };
}
