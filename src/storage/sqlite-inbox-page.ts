import type { Database } from "bun:sqlite";
import {
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";

import {
  ENCRYPTED_PAGE_JSON_MULTIPLIER,
  INBOX_PAGE_ROW_OVERHEAD_BYTES,
  MAX_INBOX_PAGE_BYTES,
  PLAINTEXT_PAGE_CONTENT_MULTIPLIER,
  requireInboxPageBudget,
} from "./inbox-page-budget.js";

export type SqliteInboxPageQuery = {
  readonly agentId: string;
  readonly afterSequence: number;
  readonly expiresAfter: string;
  readonly generation: number;
  readonly limit: number;
  readonly threadId: string | null;
  readonly unreadOnly: boolean;
};
type PageParameters = [
  string,
  number,
  number,
  string,
  number,
  string | null,
  string | null,
  number,
];

export function readSqliteInboxPage(
  database: Database,
  kind: "encrypted" | "plaintext",
  query: SqliteInboxPageQuery,
): unknown[] {
  // These SQL fragments come only from this closed storage variant, never from a caller's value.
  const table: "e2ee_messages" | "messages" = kind === "encrypted" ? "e2ee_messages" : "messages";
  const contentBytes: string =
    kind === "encrypted"
      ? "length(CAST(envelope_json AS BLOB)) + length(CAST(sender_chain_json AS BLOB))"
      : "length(CAST(content AS BLOB))";
  const multiplier: number =
    kind === "encrypted" ? ENCRYPTED_PAGE_JSON_MULTIPLIER : PLAINTEXT_PAGE_CONTENT_MULTIPLIER;
  const candidates: string = `FROM ${table}
    WHERE recipient_id = ? AND recipient_generation = ? AND sequence > ? AND expires_at > ?
      AND (? = 0 OR read_at IS NULL) AND (? IS NULL OR thread_id = ?)
    ORDER BY sequence ASC LIMIT ?`;
  const parameters: PageParameters = [
    query.agentId,
    query.generation,
    query.afterSequence,
    query.expiresAfter,
    query.unreadOnly ? 1 : 0,
    query.threadId,
    query.threadId,
    query.limit,
  ];
  const projection: string =
    kind === "encrypted" ? "sequence, envelope_json, sender_chain_json, read_at" : "*";
  const reservation: MaterializationReservation = reserveMaterializationBytes(MAX_INBOX_PAGE_BYTES);
  try {
    const page: { readonly estimatedBytes: number; readonly rows: unknown[] } =
      database.transaction((): { readonly estimatedBytes: number; readonly rows: unknown[] } => {
        const budget: unknown = database
          .query<unknown, [number, number, ...PageParameters]>(`
        SELECT COALESCE(SUM(estimated_bytes), 0) AS estimated_page_bytes
        FROM (SELECT ? * (${contentBytes}) + ? AS estimated_bytes ${candidates})
      `)
          .get(multiplier, INBOX_PAGE_ROW_OVERHEAD_BYTES, ...parameters);
        const estimatedBytes: number = requireInboxPageBudget(budget);
        // The synchronous transaction keeps both SELECTs on the same snapshot, including read flags.
        const rows: unknown[] = database
          .query<unknown, PageParameters>(`SELECT ${projection} ${candidates}`)
          .all(...parameters);
        return { estimatedBytes, rows };
      })();
    reservation.settle(page.estimatedBytes);
    return page.rows;
  } catch (error: unknown) {
    reservation.fail();
    throw error;
  }
}
