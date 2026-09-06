import { expect, test } from "bun:test";

import type { Agent } from "../src/domain/models.js";
import { parseBudgetedAgentPage } from "../src/storage/agent-page-budget.js";
import { type AgentRow, mapAgentRow } from "../src/storage/postgres-message-rows.js";

const CORRUPTION: string = "Stored agent page accounting failed runtime validation";

function agentRow(agentId: string): AgentRow {
  return {
    agent_id: agentId,
    authority: "peer",
    closed_at: null,
    close_reason: null,
    created_at: "2030-01-01T00:00:00.000Z",
    display_name: " Reader ",
    generation: 1,
    last_seen_at: "2030-01-01T00:00:00.000Z",
    lease_expires_at: null,
    live_session_count: 0,
    metadata_json: '{ "message": "漢\\u0001" }',
    state: "inactive",
  };
}

function rowBytes(row: AgentRow): number {
  return 8_192 + 3 * Buffer.byteLength(row.metadata_json, "utf8");
}

test("agent page cost must match raw metadata JSON before normalization", (): void => {
  const row: AgentRow = agentRow("reader");
  expect(mapAgentRow(row).displayName.value).toBe("Reader");
  for (const bytes of [1, rowBytes(row) - 1, rowBytes(row) + 1]) {
    expect((): void => {
      parseBudgetedAgentPage(
        [{ estimated_page_bytes: bytes, row_json: JSON.stringify(row) }],
        mapAgentRow,
      );
    }).toThrow(CORRUPTION);
  }
});

test("underreported metadata is rejected before the domain mapper decodes its JSON", (): void => {
  let mapped: number = 0;
  const row: AgentRow = agentRow("reader");
  expect((): void => {
    parseBudgetedAgentPage(
      [{ estimated_page_bytes: 1, row_json: JSON.stringify(row) }],
      (value: unknown): Agent => {
        mapped += 1;
        return mapAgentRow(value);
      },
    );
  }).toThrow(CORRUPTION);
  expect(mapped).toBe(0);
});

test("duplicate agent identities cannot consume two fitting-prefix positions", (): void => {
  const row: AgentRow = agentRow("reader");
  expect((): void => {
    parseBudgetedAgentPage(
      [
        { estimated_page_bytes: rowBytes(row), row_json: JSON.stringify(row) },
        { estimated_page_bytes: rowBytes(row) * 2, row_json: JSON.stringify(row) },
      ],
      mapAgentRow,
    );
  }).toThrow(CORRUPTION);
});

test("exact stored metadata costs and last-visible cursors survive fitting prefix validation", (): void => {
  const first: AgentRow = agentRow("reader-a");
  const second: AgentRow = agentRow("reader-b");
  const bytes: number = rowBytes(first) + rowBytes(second);
  const page: ReturnType<typeof parseBudgetedAgentPage> = parseBudgetedAgentPage(
    [
      { estimated_page_bytes: String(rowBytes(first)), row_json: JSON.stringify(first) },
      { estimated_page_bytes: BigInt(bytes), row_json: JSON.stringify(second) },
      { estimated_page_bytes: 0, row_json: null },
    ],
    mapAgentRow,
    2,
  );
  expect(page.bytes).toBe(bytes);
  expect(page.result.agents).toEqual([mapAgentRow(first), mapAgentRow(second)]);
  expect(page.result.nextCursor).toEqual(mapAgentRow(second).agentId);
  const compactBytes: number =
    8_192 + 3 * Buffer.byteLength(JSON.stringify(JSON.parse(first.metadata_json)), "utf8");
  expect(compactBytes).toBeLessThan(rowBytes(first));
  expect((): void => {
    parseBudgetedAgentPage(
      [{ estimated_page_bytes: compactBytes, row_json: JSON.stringify(first) }],
      mapAgentRow,
      1,
    );
  }).toThrow(CORRUPTION);
});

test("agent pages enforce requested counts without rejecting the single excluded sentinel", (): void => {
  const first: AgentRow = agentRow("reader-a");
  const second: AgentRow = agentRow("reader-b");
  const row: object = { estimated_page_bytes: rowBytes(first), row_json: JSON.stringify(first) };
  expect((): void => {
    parseBudgetedAgentPage(
      [
        row,
        {
          estimated_page_bytes: rowBytes(first) + rowBytes(second),
          row_json: JSON.stringify(second),
        },
      ],
      mapAgentRow,
      1,
    );
  }).toThrow(CORRUPTION);
  expect((): void => {
    parseBudgetedAgentPage(
      [
        row,
        { estimated_page_bytes: 0, row_json: null },
        { estimated_page_bytes: 0, row_json: null },
      ],
      mapAgentRow,
      1,
    );
  }).toThrow();
  for (const limit of [0, 1_001, 1.5]) {
    expect((): void => {
      parseBudgetedAgentPage([], mapAgentRow, limit);
    }).toThrow();
  }
  expect(parseBudgetedAgentPage([], mapAgentRow, 1)).toEqual({
    bytes: 0,
    result: { agents: [], nextCursor: null },
  });
  for (const cost of [-1, Number.NaN, 0.5, "1e3", 2n ** 64n]) {
    expect((): void => {
      parseBudgetedAgentPage(
        [{ estimated_page_bytes: cost, row_json: JSON.stringify(first) }],
        mapAgentRow,
        1,
      );
    }).toThrow();
  }
});
