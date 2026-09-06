import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import type { Agent, ListAgentsResult } from "../domain/models.js";
import type { AgentId } from "../domain/value-objects.js";

export const MAX_AGENT_PAGE_BYTES: number = 8 * 1024 * 1024;
export const AGENT_PAGE_ROW_BYTES: number = 8 * 1024;
export const AGENT_METADATA_MULTIPLIER: number = 3;

type BudgetedAgentRow = {
  readonly estimated_page_bytes: number;
  readonly row_json: string | null;
};

const BudgetedAgentRowSchema: z.ZodType<BudgetedAgentRow> = z.strictObject({
  estimated_page_bytes: z
    .union([
      z.number().int().nonnegative().safe(),
      z.bigint().nonnegative().max(BigInt(Number.MAX_SAFE_INTEGER)),
      z.string().regex(/^[0-9]{1,16}$/u),
    ])
    .transform((value: bigint | number | string): number => Number(value))
    .pipe(z.number().int().nonnegative().max(MAX_AGENT_PAGE_BYTES)),
  row_json: z.string().nullable(),
});
const AgentPayloadCostSchema: z.ZodType<{ readonly metadata_json: string }> = z.object({
  metadata_json: z.string(),
});

export type BudgetedAgentPage = {
  readonly bytes: number;
  readonly result: ListAgentsResult;
};

export function parseBudgetedAgentPage(
  raw: unknown,
  mapAgent: (raw: unknown) => Agent,
  limit: number = 1_000,
): BudgetedAgentPage {
  const boundedLimit: number = z.number().int().min(1).max(1_000).parse(limit);
  const rows: BudgetedAgentRow[] = z
    .array(BudgetedAgentRowSchema)
    .max(boundedLimit + 1)
    .parse(raw);
  const agents: Agent[] = [];
  const ids: Set<string> = new Set<string>();
  let bytes: number = 0;
  let hasMore: boolean = false;
  for (const row of rows) {
    if (row.row_json === null) {
      hasMore = true;
      if (row.estimated_page_bytes !== 0) throw new Error("Invalid agent page accounting");
      continue;
    }
    if (hasMore || row.estimated_page_bytes <= bytes) {
      throw new Error("Invalid agent page ordering");
    }
    const value: unknown = JSON.parse(row.row_json);
    const parsed: z.ZodSafeParseResult<{ readonly metadata_json: string }> =
      AgentPayloadCostSchema.safeParse(value);
    if (!parsed.success) throw new StorageCorruptionError("agent", parsed.error);
    const rowBytes: number =
      AGENT_PAGE_ROW_BYTES +
      AGENT_METADATA_MULTIPLIER * Buffer.byteLength(parsed.data.metadata_json, "utf8");
    if (agents.length >= boundedLimit || row.estimated_page_bytes !== bytes + rowBytes) {
      throw new StorageCorruptionError(
        "agent page accounting",
        new Error("Invalid payload cost or identity"),
      );
    }
    const agent: Agent = mapAgent(value);
    if (ids.has(agent.agentId.value)) {
      throw new StorageCorruptionError("agent page accounting", new Error("Duplicate identity"));
    }
    ids.add(agent.agentId.value);
    agents.push(agent);
    bytes = row.estimated_page_bytes;
  }
  let nextCursor: AgentId | null = null;
  if (hasMore) {
    const lastAgent: Agent | undefined = agents.at(-1);
    if (lastAgent === undefined) {
      throw new Error("Stored agent exceeds the safe page size; contact the service owner.");
    }
    nextCursor = lastAgent.agentId;
  }
  return { bytes, result: { agents, nextCursor } };
}
