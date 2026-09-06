import { expect, test } from "bun:test";

import { toListAgentsOutput } from "../src/domain/agent-contracts.js";
import type { Agent, ListAgentsResult } from "../src/domain/models.js";
import { AgentId, DisplayName, Instant } from "../src/domain/value-objects.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import { parseBudgetedAgentPage } from "../src/storage/agent-page-budget.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

test("large agent metadata pages remain bounded and cursors preserve every agent", (): void => {
  const store: SqliteMessageStore = new SqliteMessageStore(
    ":memory:",
    new MutableClock(Instant.parse("2026-01-01T00:00:00.000Z")),
  );
  try {
    const expected: string[] = [];
    for (let index: number = 0; index < 300; index += 1) {
      const id: string = `agent-${index.toString().padStart(4, "0")}`;
      expected.push(id);
      store.registerAgent({
        agentId: AgentId.parse(id),
        displayName: DisplayName.parse(id),
        metadata: { value: "x".repeat(16_000) },
      });
    }
    const collected: string[] = [];
    let cursor: AgentId | null = null;
    let pages: number = 0;
    do {
      const page: ListAgentsResult = store.listAgents({ cursor, limit: 1_000, state: "active" });
      const wireBytes: number = Buffer.byteLength(
        JSON.stringify(toolResult(toListAgentsOutput(page))),
        "utf8",
      );
      expect(wireBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(page.agents.length).toBeGreaterThan(0);
      collected.push(...page.agents.map((agent: Agent): string => agent.agentId.value));
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 300) throw new Error("Agent pagination did not advance");
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(300);
  } finally {
    store.close();
  }
});

test("agent page boundary rejects invalid accounting before materializing metadata", (): void => {
  const unexpected: (_raw: unknown) => Agent = (_raw: unknown): Agent => {
    throw new Error("Agent mapper must not run");
  };
  expect(parseBudgetedAgentPage([], unexpected)).toEqual({
    bytes: 0,
    result: { agents: [], nextCursor: null },
  });
  for (const raw of [
    null,
    [{ estimated_page_bytes: -1, row_json: null }],
    [{ estimated_page_bytes: "invalid", row_json: null }],
    [{ estimated_page_bytes: Number.MAX_SAFE_INTEGER, row_json: null }],
    [{ estimated_page_bytes: 1, row_json: null }],
    [{ estimated_page_bytes: 0, row_json: "{}" }],
    [
      { estimated_page_bytes: 0, row_json: null },
      { estimated_page_bytes: 10, row_json: "{}" },
    ],
  ]) {
    expect((): void => {
      parseBudgetedAgentPage(raw, unexpected);
    }).toThrow();
  }
  expect((): void => {
    parseBudgetedAgentPage([{ estimated_page_bytes: 0, row_json: null }], unexpected);
  }).toThrow("Stored agent exceeds the safe page size");
});
