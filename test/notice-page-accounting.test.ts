import { expect, test } from "bun:test";

import { toListNoticesOutput } from "../src/domain/notice-contracts.js";
import type { Notice } from "../src/domain/notice-models.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import {
  fitNoticePrefix,
  MAX_NOTICE_PAGE_BYTES,
  NOTICE_PAGE_ROW_BYTES,
  parsePostgresNoticePage,
} from "../src/storage/notice-page-budget.js";
import { mapNoticeRow, type NoticeRow } from "../src/storage/notice-rows.js";
import { NOTICE_PAGE_NOW, noticePageRow } from "./support/notice-page-rows.js";

test("notice prefix accounting includes the exact boundary and stops at the first nonfitting row", (): void => {
  for (const exact of [
    MAX_NOTICE_PAGE_BYTES,
    BigInt(MAX_NOTICE_PAGE_BYTES),
    String(MAX_NOTICE_PAGE_BYTES),
  ]) {
    expect(fitNoticePrefix([{ estimated_bytes: exact }], 1)).toEqual({
      bytes: MAX_NOTICE_PAGE_BYTES,
      count: 1,
      hasMore: false,
    });
  }
  expect(fitNoticePrefix([], 500)).toEqual({ bytes: 0, count: 0, hasMore: false });
  expect(
    fitNoticePrefix(
      [{ estimated_bytes: MAX_NOTICE_PAGE_BYTES }, { estimated_bytes: NOTICE_PAGE_ROW_BYTES }],
      500,
    ),
  ).toEqual({ bytes: MAX_NOTICE_PAGE_BYTES, count: 1, hasMore: true });
  expect(
    fitNoticePrefix(
      [
        { estimated_bytes: NOTICE_PAGE_ROW_BYTES },
        { estimated_bytes: MAX_NOTICE_PAGE_BYTES },
        { estimated_bytes: NOTICE_PAGE_ROW_BYTES },
      ],
      500,
    ),
  ).toEqual({ bytes: NOTICE_PAGE_ROW_BYTES, count: 1, hasMore: true });
  expect(
    fitNoticePrefix(
      [{ estimated_bytes: NOTICE_PAGE_ROW_BYTES }, { estimated_bytes: NOTICE_PAGE_ROW_BYTES }],
      1,
    ),
  ).toEqual({ bytes: NOTICE_PAGE_ROW_BYTES, count: 1, hasMore: true });
  expect((): void => {
    fitNoticePrefix([{ estimated_bytes: MAX_NOTICE_PAGE_BYTES + 1 }], 1);
  }).toThrow("Stored notice exceeds the safe page size; contact the service owner.");
});

test("notice accounting rejects malformed and inconsistent database cost envelopes", (): void => {
  for (const value of [null, undefined, -1, 0, 0.5, Number.NaN, "1e6", 2n ** 64n]) {
    expect((): void => {
      fitNoticePrefix([{ estimated_bytes: value }], 1);
    }).toThrow();
  }
  expect((): void => {
    fitNoticePrefix(
      Array.from({ length: 502 }, (): object => ({ estimated_bytes: NOTICE_PAGE_ROW_BYTES })),
      500,
    );
  }).toThrow();
  const row: { readonly estimated_page_bytes: number; readonly row_json: string } = {
    estimated_page_bytes: NOTICE_PAGE_ROW_BYTES + 13,
    row_json: JSON.stringify(noticePageRow(1, "x")),
  };
  for (const rows of [
    [{ estimated_page_bytes: 1, row_json: null }],
    [row, row],
    [{ estimated_page_bytes: 0, row_json: null }, row],
    [{ ...row, estimated_page_bytes: MAX_NOTICE_PAGE_BYTES + 1 }],
    [{ ...row, row_json: "not-json" }],
    [{ ...row, row_json: JSON.stringify({ ...noticePageRow(1, "x"), content: 1 }) }],
  ])
    expect((): void => {
      parsePostgresNoticePage(rows, NOTICE_PAGE_NOW);
    }).toThrow();
  expect((): void => {
    parsePostgresNoticePage([{ estimated_page_bytes: 0, row_json: null }], NOTICE_PAGE_NOW);
  }).toThrow("Stored notice exceeds the safe page size; contact the service owner.");
  expect((): void => {
    parsePostgresNoticePage(
      [{ ...row, row_json: JSON.stringify({ ...noticePageRow(1, "x"), content: 1 }) }],
      NOTICE_PAGE_NOW,
    );
  }).toThrow("Stored notice failed runtime validation");
});

test("PostgreSQL notice accounting rejects a schema-valid payload whose actual bytes exceed its claimed cost", (): void => {
  const row: NoticeRow = {
    ...noticePageRow(1, "\u0001".repeat(100_000)),
    resolution_note: "漢".repeat(2000),
    resolved_at: NOTICE_PAGE_NOW.toISOString(),
    resolved_by_id: "reader",
    resolved_by_generation: 1,
  };
  expect((): void => {
    parsePostgresNoticePage(
      [{ estimated_page_bytes: NOTICE_PAGE_ROW_BYTES + 13, row_json: JSON.stringify(row) }],
      NOTICE_PAGE_NOW,
    );
  }).toThrow("Stored notice page accounting failed runtime validation");
});

test("PostgreSQL notice accounting rejects repeated IDs even when cumulative costs increase correctly", (): void => {
  const cost: number = NOTICE_PAGE_ROW_BYTES + 13;
  const rowJson: string = JSON.stringify(noticePageRow(1, "x"));
  expect((): void => {
    parsePostgresNoticePage(
      [
        { estimated_page_bytes: cost, row_json: rowJson },
        { estimated_page_bytes: cost * 2, row_json: rowJson },
      ],
      NOTICE_PAGE_NOW,
    );
  }).toThrow("Stored notice page accounting failed runtime validation");
});

test("PostgreSQL notice cost exactly includes UTF-8 content, stored resolution whitespace and prior rows", (): void => {
  const first: NoticeRow = noticePageRow(1, "漢");
  const second: NoticeRow = {
    ...noticePageRow(2, "\u0001"),
    resolution_note: " 漢 ",
    resolved_at: NOTICE_PAGE_NOW.toISOString(),
    resolved_by_id: "reader",
    resolved_by_generation: 1,
  };
  const firstCost: number = NOTICE_PAGE_ROW_BYTES + 13 * 3;
  const totalCost: number = firstCost + NOTICE_PAGE_ROW_BYTES + 13 * (1 + 5);
  const page: ReturnType<typeof parsePostgresNoticePage> = parsePostgresNoticePage(
    [
      { estimated_page_bytes: firstCost, row_json: JSON.stringify(first) },
      { estimated_page_bytes: String(totalCost), row_json: JSON.stringify(second) },
      { estimated_page_bytes: 0, row_json: null },
    ],
    NOTICE_PAGE_NOW,
  );
  expect(page.bytes).toBe(totalCost);
  expect(page.result.notices).toHaveLength(2);
  const secondNotice: Notice | undefined = page.result.notices[1];
  if (secondNotice === undefined || secondNotice.resolutionNote === null)
    throw new Error("Expected resolution note fixture");
  expect(secondNotice.resolutionNote.value).toBe("漢");
  for (const claimed of [totalCost - 1, totalCost + 1, totalCost - 26]) {
    expect((): void => {
      parsePostgresNoticePage(
        [
          { estimated_page_bytes: firstCost, row_json: JSON.stringify(first) },
          { estimated_page_bytes: claimed, row_json: JSON.stringify(second) },
        ],
        NOTICE_PAGE_NOW,
      );
    }).toThrow("Stored notice page accounting failed runtime validation");
  }
});

test("duplicate UUID spelling variants cannot bypass notice identity validation", (): void => {
  const row: NoticeRow = {
    ...noticePageRow(1, "x"),
    notice_id: "abcdef00-0000-4000-8000-000000000001",
  };
  const cost: number = NOTICE_PAGE_ROW_BYTES + 13;
  expect((): void => {
    parsePostgresNoticePage(
      [
        { estimated_page_bytes: cost, row_json: JSON.stringify(row) },
        {
          estimated_page_bytes: cost * 2,
          row_json: JSON.stringify({ ...row, notice_id: row.notice_id.toUpperCase() }),
        },
      ],
      NOTICE_PAGE_NOW,
    );
  }).toThrow("Stored notice page accounting failed runtime validation");
});

test("PostgreSQL notice sentinels preserve the last visible cursor and never decode excluded payloads", (): void => {
  const row: NoticeRow = noticePageRow(1, "x");
  const page: ReturnType<typeof parsePostgresNoticePage> = parsePostgresNoticePage(
    [
      { estimated_page_bytes: String(NOTICE_PAGE_ROW_BYTES + 13), row_json: JSON.stringify(row) },
      { estimated_page_bytes: 0, row_json: null },
      { estimated_page_bytes: 0n, row_json: null },
    ],
    NOTICE_PAGE_NOW,
  );
  expect(page.bytes).toBe(NOTICE_PAGE_ROW_BYTES + 13);
  expect(page.result.notices).toHaveLength(1);
  const cursor: typeof page.result.nextCursor = page.result.nextCursor;
  expect(cursor === null ? null : cursor.noticeId.value).toBe(row.notice_id);
  expect(parsePostgresNoticePage([], NOTICE_PAGE_NOW)).toEqual({
    bytes: 0,
    result: { notices: [], nextCursor: null },
  });
  expect(
    parsePostgresNoticePage(
      [{ estimated_page_bytes: BigInt(NOTICE_PAGE_ROW_BYTES + 13), row_json: JSON.stringify(row) }],
      NOTICE_PAGE_NOW,
    ).result.nextCursor,
  ).toBeNull();
});

test("notice estimates cover maximal valid control and Unicode fields without serializing giant pages", (): void => {
  for (const content of [
    "\u0001".repeat(100_000),
    "漢".repeat(100_000),
    "\ud800".repeat(100_000),
  ]) {
    const row: NoticeRow = {
      ...noticePageRow(1, content),
      branch_name: "\u0001".repeat(500),
      creator_id: "a".repeat(200),
      repository_name: `a/${"r".repeat(498)}`,
      resolution_note: "\u0001".repeat(2000),
      resolved_at: NOTICE_PAGE_NOW.toISOString(),
      resolved_by_generation: Number.MAX_SAFE_INTEGER,
      resolved_by_id: "b".repeat(200),
    };
    const notice: Notice = mapNoticeRow(row, NOTICE_PAGE_NOW);
    const estimate: number = 13 * (Buffer.byteLength(content) + 2000) + NOTICE_PAGE_ROW_BYTES;
    const wireBytes: number = Buffer.byteLength(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        result: toolResult(
          toListNoticesOutput({
            notices: [notice],
            nextCursor: { createdAt: notice.createdAt, noticeId: notice.noticeId },
          }),
        ),
      }),
    );
    expect(wireBytes).toBeLessThanOrEqual(estimate);
    expect(estimate).toBeLessThan(MAX_NOTICE_PAGE_BYTES);
  }
});
