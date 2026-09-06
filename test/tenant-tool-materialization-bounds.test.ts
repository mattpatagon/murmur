import { expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  type SubmitFeedbackOutput,
  SubmitFeedbackOutputSchema,
} from "../src/domain/feedback-contracts.js";
import {
  type ListTokensOutput,
  ListTokensOutputSchema,
  type TokenSummaryDto,
  TokenSummaryDtoSchema,
} from "../src/hosted/contracts.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import {
  feedbackRetainedBytes,
  MAX_FEEDBACK_MATERIALIZATION_BYTES,
  MAX_TOKEN_LIST_MATERIALIZATION_BYTES,
  materializedToolResult,
  TOKEN_LIST_ROW_BYTES,
  TOOL_ENVELOPE_BYTES,
  tokenListRetainedBytes,
} from "../src/mcp/bounded-tool-materialization.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import { FIXTURE_ID, FIXTURE_INSTANT } from "./support/tenant-tool-materialization-fixture.js";

const TEXT_VARIANTS: readonly string[] = ["\u0001", "漢", "🌊", "\ud800", "\udfff", '"\\'];

function maximumText(pattern: string, units: number): string {
  return pattern.repeat(Math.ceil(units / pattern.length)).slice(0, units);
}

function maximumToken(pattern: string): TokenSummaryDto {
  return TokenSummaryDtoSchema.parse({
    // Even the DTO's weaker character-only agent bound fits; stored AgentId is ASCII-only.
    agent_id: maximumText(pattern, 200),
    created_at: FIXTURE_INSTANT.toISOString(),
    expires_at: FIXTURE_INSTANT.toISOString(),
    key_id: "k".repeat(32),
    last_used_at: FIXTURE_INSTANT.toISOString(),
    name: maximumText(pattern, 200),
    personal_id: FIXTURE_ID,
    repository: `a/${"b".repeat(498)}`,
    revoked_at: FIXTURE_INSTANT.toISOString(),
    role: "orchestrator",
    token_id: FIXTURE_ID,
  });
}

function wireBytes(output: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(CallToolResultSchema.parse(toolResult(output))), "utf8");
}

test("token row and envelope allowances cover maximum escaped schema values without a giant page", (): void => {
  for (const pattern of TEXT_VARIANTS) {
    const token: TokenSummaryDto = maximumToken(pattern);
    const empty: ListTokensOutput = ListTokensOutputSchema.parse({
      next_cursor: FIXTURE_ID,
      tokens: [],
    });
    const small: ListTokensOutput = ListTokensOutputSchema.parse({
      next_cursor: FIXTURE_ID,
      tokens: [token, token],
    });
    const row: string = JSON.stringify(token);
    const rowWireBytes: number =
      Buffer.byteLength(row, "utf8") + Buffer.byteLength(JSON.stringify(row), "utf8") - 2;
    const envelope: number = wireBytes(empty);
    expect(wireBytes(small)).toBe(envelope + 2 * rowWireBytes + 2);
    expect(rowWireBytes + 2).toBeLessThanOrEqual(TOKEN_LIST_ROW_BYTES);
    expect(envelope).toBeLessThanOrEqual(TOOL_ENVELOPE_BYTES);
    const maximum: ListTokensOutput = ListTokensOutputSchema.parse({
      next_cursor: FIXTURE_ID,
      tokens: Array.from({ length: 500 }, (): TokenSummaryDto => token),
    });
    const estimate: number = tokenListRetainedBytes(maximum);
    expect(envelope + 500 * rowWireBytes + 2 * 499).toBeLessThanOrEqual(estimate);
    expect(estimate).toBe(4_104_192);
    // PostgreSQL fetches one lookahead row before the common tool receives its page.
    expect(estimate + TOKEN_LIST_ROW_BYTES).toBeLessThan(MAX_TOKEN_LIST_MATERIALIZATION_BYTES);
  }
});

test("feedback estimates cover maximum controls, Unicode and lone surrogates in real wire schemas", (): void => {
  for (const pattern of TEXT_VARIANTS) {
    const output: SubmitFeedbackOutput = SubmitFeedbackOutputSchema.parse({
      duplicate: true,
      status: "stored",
      submission: {
        context: {
          branch: maximumText(pattern, 500),
          client: "connector",
          repository: `a/${"b".repeat(498)}`,
        },
        created_at: FIXTURE_INSTANT.toISOString(),
        description: maximumText(pattern, 100_000),
        reporter_generation: Number.MAX_SAFE_INTEGER,
        reporter_id: "a".repeat(200),
        submission_id: FIXTURE_ID,
        title: maximumText(pattern, 200),
        type: "feature_request",
      },
    });
    const estimate: number = feedbackRetainedBytes(output);
    expect(wireBytes(output)).toBeLessThanOrEqual(estimate);
    expect(estimate).toBe(1_317_292);
    expect(estimate).toBeLessThan(MAX_FEEDBACK_MATERIALIZATION_BYTES);
  }
});

test("token estimator rejects a page exceeding the existing protocol row cap", (): void => {
  const token: TokenSummaryDto = maximumToken("x");
  const output: ListTokensOutput = ListTokensOutputSchema.parse({
    next_cursor: null,
    tokens: Array.from({ length: 501 }, (): TokenSummaryDto => token),
  });
  expect((): number => tokenListRetainedBytes(output)).toThrow("Invalid token page length");
});

test("invalid estimates reject before serialization and release reservations", async (): Promise<void> => {
  const budget: MaterializationByteBudget = new MaterializationByteBudget(64);
  const scope: MaterializationScope = new MaterializationScope(budget);
  let serializations: number = 0;
  const output: Record<string, unknown> = {
    toJSON: (): Record<string, unknown> => {
      serializations += 1;
      return { value: "should not serialize" };
    },
  };
  try {
    for (const invalid of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      65,
    ]) {
      await expect(
        withMaterializationScope(
          scope,
          async (): Promise<unknown> =>
            await materializedToolResult(
              64,
              async (): Promise<Record<string, unknown>> => output,
              (): number => invalid,
            ),
        ),
      ).rejects.toThrow("Invalid tool materialization estimate");
      expect(serializations).toBe(0);
      expect(budget.reservedBytes).toBe(0);
    }
  } finally {
    scope.finishResponse();
  }
});

test("serialization failure releases actual failed work without waiting for response completion", async (): Promise<void> => {
  const budget: MaterializationByteBudget = new MaterializationByteBudget(64);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const output: Record<string, unknown> = {};
  output["self"] = output;
  try {
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<unknown> =>
          await materializedToolResult(
            64,
            async (): Promise<Record<string, unknown>> => output,
            (): number => 1,
          ),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(budget.reservedBytes).toBe(0);
    await withMaterializationScope(
      scope,
      async (): Promise<unknown> =>
        await materializedToolResult(
          64,
          async (): Promise<Record<string, unknown>> => ({ ok: true }),
          (): number => 32,
        ),
    );
    expect(budget.reservedBytes).toBe(32);
  } finally {
    scope.finishResponse();
  }
  expect(budget.reservedBytes).toBe(0);
});
