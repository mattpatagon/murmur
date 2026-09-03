import type { Database } from "bun:sqlite";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { MAX_RETAINED_AGENTS } from "../domain/lifecycle-values.js";
import { safeSqlCount } from "./local-vault-rows.js";

const PRUNE_BATCH_SIZE: number = 1_000;
const DAY_MILLISECONDS: number = 24 * 60 * 60 * 1_000;

function expiredCandidateQuery(): string {
  return `
    SELECT agent_id FROM agent_keys AS candidate
    WHERE (candidate.expires_at <= ? OR candidate.retired_at <= ?)
      AND NOT EXISTS (
        SELECT 1 FROM outbox WHERE outbox.sender_id = candidate.agent_id
      )
    ORDER BY candidate.expires_at, candidate.agent_id
    LIMIT ${PRUNE_BATCH_SIZE}
  `;
}

export function ensureLocalAgentKeyCapacity(database: Database): void {
  const count: number = safeSqlCount(
    database.query<unknown, []>("SELECT COUNT(*) AS count FROM agent_keys").get(),
  );
  if (count >= MAX_RETAINED_AGENTS) throw new Error("Local E2E agent key capacity reached");
}

export function purgeExpiredLocalAgentKeys(database: Database, now: string): number {
  const nowMilliseconds: number = Date.parse(now);
  if (!Number.isFinite(nowMilliseconds)) throw new Error("Local E2E purge time is invalid");
  const retiredCutoff: string = new Date(
    nowMilliseconds - RETENTION_DAYS * DAY_MILLISECONDS,
  ).toISOString();
  const candidates: string = expiredCandidateQuery();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .query<unknown, [string, string]>(`DELETE FROM prekeys WHERE agent_id IN (${candidates})`)
      .run(now, retiredCutoff);
    const deleted: number = database
      .query<unknown, [string, string]>(`DELETE FROM agent_keys WHERE agent_id IN (${candidates})`)
      .run(now, retiredCutoff).changes;
    database.exec("COMMIT");
    return deleted;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function activateLocalAgentKey(database: Database, agentId: string): void {
  database
    .query<unknown, [string]>("UPDATE agent_keys SET retired_at = NULL WHERE agent_id = ?")
    .run(agentId);
}

export function retireLocalAgentKey(database: Database, agentId: string, retiredAt: string): void {
  database
    .query<unknown, [string, string]>("UPDATE agent_keys SET retired_at = ? WHERE agent_id = ?")
    .run(retiredAt, agentId);
}
