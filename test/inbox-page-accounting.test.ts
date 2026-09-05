import { expect, test } from "bun:test";
import { z } from "zod";

import { InboxOutputSchema, type MessageDto, MessageDtoSchema } from "../src/domain/contracts.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import {
  INBOX_PAGE_ROW_OVERHEAD_BYTES,
  MAX_INBOX_PAGE_BYTES,
  parsePostgresInboxPage,
  requireInboxPageBudget,
  requirePostgresInboxPageBudget,
} from "../src/storage/inbox-page-budget.js";
import { PAGE_ERROR, PAGE_TEST_NOW } from "./support/inbox-page-fixture.js";

test("page accounting accepts the exact inclusive boundary across database integer encodings", (): void => {
  for (const estimatedBytes of [0, MAX_INBOX_PAGE_BYTES, BigInt(MAX_INBOX_PAGE_BYTES), "8388608"]) {
    expect(requireInboxPageBudget({ estimated_page_bytes: estimatedBytes })).toBe(
      Number(estimatedBytes),
    );
  }
  expect((): void => {
    requireInboxPageBudget({ estimated_page_bytes: MAX_INBOX_PAGE_BYTES + 1 });
  }).toThrow(PAGE_ERROR);
});

test("page accounting rejects malformed rows before decoding payloads", (): void => {
  for (const value of [
    null,
    undefined,
    -1,
    0.5,
    Number.NaN,
    "1e6",
    "private-sentinel",
    2n ** 64n,
  ]) {
    expect((): void => {
      requireInboxPageBudget({ estimated_page_bytes: value });
    }).toThrow("Stored inbox page byte accounting failed runtime validation");
  }
  expect((): void => {
    requirePostgresInboxPageBudget({ estimated_page_bytes: 0 });
  }).toThrow("Stored inbox page byte accounting failed runtime validation");
  expect((): void => {
    requirePostgresInboxPageBudget([{ estimated_page_bytes: 1 }, { estimated_page_bytes: 2 }]);
  }).toThrow("Stored inbox page byte accounting failed runtime validation");
  expect((): void => {
    parsePostgresInboxPage(
      [{ estimated_page_bytes: MAX_INBOX_PAGE_BYTES + 1, payload: "private-sentinel" }],
      z.strictObject({ payload: z.never() }),
      { kind: "plaintext", limit: 500 },
    );
  }).toThrow(PAGE_ERROR);
});

test("the internal PostgreSQL byte header never changes strict message row contracts", (): void => {
  const rowSchema: z.ZodType<{
    readonly sequence: number;
    readonly content: string;
    readonly message_id: string;
  }> = z.strictObject({
    sequence: z.number(),
    content: z.string(),
    message_id: z.string().uuid(),
  });
  const first: {
    readonly sequence: number;
    readonly content: string;
    readonly message_id: string;
  } = { sequence: 1, content: "x", message_id: "00000000-0000-4000-8000-000000000001" };
  const second: typeof first = {
    ...first,
    sequence: 2,
    message_id: "00000000-0000-4000-8000-000000000002",
  };
  const total: number = 2 * (INBOX_PAGE_ROW_OVERHEAD_BYTES + 13);
  expect(parsePostgresInboxPage([], rowSchema, { kind: "plaintext", limit: 500 })).toEqual({
    estimatedBytes: 0,
    rows: [],
  });
  expect(
    parsePostgresInboxPage(
      [
        { ...first, estimated_page_bytes: String(total) },
        { ...second, estimated_page_bytes: BigInt(total) },
      ],
      rowSchema,
      { kind: "plaintext", limit: 500 },
    ),
  ).toEqual({ estimatedBytes: total, rows: [first, second] });
  expect((): void => {
    parsePostgresInboxPage([{ estimated_page_bytes: 1, sequence: "invalid" }], rowSchema, {
      kind: "plaintext",
      limit: 500,
    });
  }).toThrow();
});

test("plaintext estimates dominate real MCP JSON control, Unicode and surrogate expansion", (): void => {
  for (const content of [
    "\u0001".repeat(100_000),
    "漢".repeat(100_000),
    "\ud800".repeat(100_000),
  ]) {
    const message: MessageDto = MessageDtoSchema.parse({
      content,
      context: {
        branch: "\u0001".repeat(500),
        client: "codex",
        repository: `a/${"r".repeat(498)}`,
      },
      created_at: PAGE_TEST_NOW,
      expires_at: "2030-01-31T00:00:00.000Z",
      message_id: "00000000-0000-4000-8000-000000000001",
      message_kind: "message",
      orchestrator_policy_id: null,
      read_at: null,
      recipient_id: "b".repeat(200),
      sender_authority: "peer",
      sender_id: "a".repeat(200),
      sequence: Number.MAX_SAFE_INTEGER,
      thread_id: "\u0001".repeat(200),
    });
    const output: ReturnType<typeof InboxOutputSchema.parse> = InboxOutputSchema.parse({
      agent_id: message.recipient_id,
      inbox_version: message.sequence,
      messages: [message],
    });
    const estimatedBytes: number =
      13 * Buffer.byteLength(content, "utf8") + INBOX_PAGE_ROW_OVERHEAD_BYTES;
    const wireBytes: number = Buffer.byteLength(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: toolResult(output) }),
      "utf8",
    );
    expect(estimatedBytes).toBeLessThan(MAX_INBOX_PAGE_BYTES);
    expect(wireBytes).toBeLessThanOrEqual(estimatedBytes);
  }
});
