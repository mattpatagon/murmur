import { expect, spyOn, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { StorageCorruptionError } from "../src/domain/errors.js";
import { TenantId } from "../src/domain/value-objects.js";
import type {
  OrchestratorPolicy,
  Page,
  TenantPrincipal,
} from "../src/hosted/control-plane-contracts.js";
import { page } from "../src/hosted/control-plane-rows.js";
import { toOrchestratorPolicyDto } from "../src/hosted/orchestration-contracts.js";
import { listPostgresOrchestratorPolicies } from "../src/hosted/orchestration-policy-list.js";
import {
  MAX_POLICY_PAGE_BYTES,
  POLICY_INSTRUCTIONS_MULTIPLIER,
  POLICY_PAGE_ROW_BYTES,
  parseBudgetedPolicyPage,
} from "../src/hosted/orchestration-policy-page.js";
import {
  mapOrchestratorPolicy,
  type OrchestratorPolicyRow,
  OrchestratorPolicyRowSchema,
} from "../src/hosted/orchestration-rows.js";
import {
  MaterializationByteBudget,
  MaterializationCapacityError,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";

function policyRow(
  index: number,
  instructions: string = "\u0001".repeat(8192),
): OrchestratorPolicyRow {
  return OrchestratorPolicyRowSchema.parse({
    created_at: "2026-09-05T00:00:00.000Z",
    created_by_token_id: "00000000-0000-4000-8000-000000000002",
    enabled: true,
    instructions,
    machine_name: "m".repeat(200),
    orchestrator_agent_id: "a".repeat(200),
    orchestrator_token_id: "00000000-0000-4000-8000-000000000002",
    policy_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    repository_name: `a/${"r".repeat(494)}${String(index).padStart(4, "0")}`,
    scope_kind: "organization",
    scope_owner_id: "00000000-0000-4000-8000-000000000001",
    updated_at: "2026-09-05T00:00:00.000Z",
    updated_by_token_id: "00000000-0000-4000-8000-000000000002",
  });
}

type BudgetRow = {
  readonly policy_id: string;
  readonly page_row: number;
  readonly estimated_page_bytes: number;
  readonly row_json: string | null;
};
function budgetRows(rows: readonly OrchestratorPolicyRow[], limit: number = 100): BudgetRow[] {
  let bytes: number = 0;
  return rows.slice(0, limit + 1).map((row: OrchestratorPolicyRow, index: number): BudgetRow => {
    bytes +=
      POLICY_PAGE_ROW_BYTES +
      Buffer.byteLength(row.instructions, "utf8") * POLICY_INSTRUCTIONS_MULTIPLIER;
    const fits: boolean = index < limit && bytes <= MAX_POLICY_PAGE_BYTES;
    return {
      policy_id: row.policy_id,
      page_row: index + 1,
      estimated_page_bytes: fits ? bytes : 0,
      row_json: fits ? JSON.stringify(row) : null,
    };
  });
}

function wireBytes(result: Page<OrchestratorPolicy>): number {
  const empty: string = JSON.stringify(
    toolResult({ next_cursor: result.nextCursor, policies: [] }),
  );
  let bytes: number = Buffer.byteLength(empty, "utf8");
  for (const item of result.items) {
    const row: string = JSON.stringify(toOrchestratorPolicyDto(item));
    bytes += Buffer.byteLength(row, "utf8") + Buffer.byteLength(JSON.stringify(row), "utf8") - 2;
  }
  return bytes + Math.max(0, result.items.length - 1) * 2;
}

test("policy pages fit control-character instructions without building a giant wire string", (): void => {
  const rows: OrchestratorPolicyRow[] = Array.from(
    { length: 100 },
    (_unused: unknown, index: number): OrchestratorPolicyRow => policyRow(index),
  );
  const policies: OrchestratorPolicy[] = rows.map(mapOrchestratorPolicy);
  const small: Page<OrchestratorPolicy> = page(
    policies,
    2,
    (item: OrchestratorPolicy): string => item.policyId.value,
  );
  expect(wireBytes(small)).toBe(
    Buffer.byteLength(
      JSON.stringify(
        toolResult({
          next_cursor: small.nextCursor,
          policies: small.items.map(toOrchestratorPolicyDto),
        }),
      ),
      "utf8",
    ),
  );
  expect(wireBytes({ items: policies, nextCursor: null })).toBe(10_924_930);
  const { bytes, result }: ReturnType<typeof parseBudgetedPolicyPage> = parseBudgetedPolicyPage(
    budgetRows(rows),
    100,
  );
  expect(wireBytes(result)).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(wireBytes(result)).toBeLessThanOrEqual(bytes);
  expect(result.items).toHaveLength(73);
  expect(result.nextCursor).toBe(policyRow(72).policy_id);
  const remaining: Page<OrchestratorPolicy> = parseBudgetedPolicyPage(
    budgetRows(rows.slice(73)),
    100,
  ).result;
  expect(remaining.nextCursor).toBeNull();
  expect([...result.items, ...remaining.items]).toEqual(policies);
});

test("policy byte accounting covers Unicode, controls and bounded fixed fields", (): void => {
  for (const instructions of [
    "x",
    "\u0001".repeat(8192),
    "漢".repeat(2730),
    "\ud800".repeat(2730),
  ]) {
    const parsed: ReturnType<typeof parseBudgetedPolicyPage> = parseBudgetedPolicyPage(
      budgetRows([policyRow(0, instructions)]),
      100,
    );
    expect(wireBytes(parsed.result)).toBeLessThanOrEqual(parsed.bytes);
    expect(parsed.result.nextCursor).toBeNull();
  }
  expect(parseBudgetedPolicyPage([], 100)).toEqual({
    bytes: 0,
    result: { items: [], nextCursor: null },
  });
  const limited: ReturnType<typeof parseBudgetedPolicyPage> = parseBudgetedPolicyPage(
    budgetRows([policyRow(0), policyRow(1)], 1),
    1,
  );
  expect(limited.result.items).toHaveLength(1);
  expect(limited.result.nextCursor).toBe(policyRow(0).policy_id);
});

test("policy page validation rejects broken snapshots, prefix holes and accounting", (): void => {
  const [first, second, third]: BudgetRow[] = budgetRows([
    policyRow(0),
    policyRow(1),
    policyRow(2),
  ]);
  if (first === undefined || second === undefined || third === undefined)
    throw new Error("Missing budget fixtures");
  for (const invalid of [
    null,
    Array.from({ length: 102 }, (): BudgetRow => first),
    [{ ...first, page_row: 2 }],
    [{ ...first, estimated_page_bytes: -1 }],
    [{ ...first, estimated_page_bytes: "1e6" }],
    [{ ...first, estimated_page_bytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    [{ ...first, estimated_page_bytes: MAX_POLICY_PAGE_BYTES + 1 }],
    [{ ...first, estimated_page_bytes: 0 }],
    [{ ...first, row_json: "{}" }],
    [{ ...first, row_json: "not JSON" }],
    [{ ...first, policy_id: second.policy_id }],
    [{ ...first, row_json: null }],
    [{ ...first, row_json: null, estimated_page_bytes: 0 }],
    [first, { ...second, policy_id: first.policy_id }],
    [first, { ...second, row_json: null, estimated_page_bytes: 0 }, third],
  ]) {
    expect((): unknown => parseBudgetedPolicyPage(invalid, 100)).toThrow(StorageCorruptionError);
  }
  expect((): unknown => parseBudgetedPolicyPage([first, second], 1)).toThrow(
    StorageCorruptionError,
  );
  for (const count of [String(first.estimated_page_bytes), BigInt(first.estimated_page_bytes)]) {
    expect(parseBudgetedPolicyPage([{ ...first, estimated_page_bytes: count }], 100).bytes).toBe(
      first.estimated_page_bytes,
    );
  }
});

test("policy admission rejects before opening a transaction and releases failures", async (): Promise<void> => {
  // A lazy client plus a stubbed transaction method cannot open a database connection.
  const database: Sql = postgres({
    host: "127.0.0.1",
    port: 1,
    database: "unused",
    username: "unused",
  });
  const begin: ReturnType<typeof spyOn<Sql, "begin">> = spyOn(database, "begin").mockRejectedValue(
    new Error("Fixture transaction failed"),
  );
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_POLICY_PAGE_BYTES);
  const held: ReturnType<MaterializationByteBudget["reserve"]> =
    budget.reserve(MAX_POLICY_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const principal: TenantPrincipal = {
    kind: "tenant",
    role: "tenant_admin",
    tenantId: TenantId.founding(),
    tokenId: "00000000-0000-4000-8000-000000000002",
  };
  try {
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<unknown> =>
          await listPostgresOrchestratorPolicies(database, principal, null, 100),
      ),
    ).rejects.toThrow(MaterializationCapacityError);
    expect(begin).not.toHaveBeenCalled();
    held.release();
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<unknown> =>
          await listPostgresOrchestratorPolicies(database, principal, null, 100),
      ),
    ).rejects.toThrow("Fixture transaction failed");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(budget.reservedBytes).toBe(0);
    await expect(
      listPostgresOrchestratorPolicies(database, principal, null, 101),
    ).rejects.toThrow();
    expect(begin).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    scope.finishResponse();
    begin.mockRestore();
    await database.end({ timeout: 1 });
  }
});
