import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  assertE2eeDeliveryBatch,
  type E2eeDeliverySnapshot,
  e2eeDeliveryBatches,
  maximumE2eeCommitBatchBytes,
  parseE2eeDeliverySnapshot,
} from "../src/storage/e2ee-broadcast-commit-batches.js";
import type { SqliteE2eeDeliveryRow } from "../src/storage/sqlite-e2ee-rows.js";

function snapshot(count: number): readonly E2eeDeliverySnapshot[] {
  return Array.from(
    { length: count },
    (_unused: unknown, index: number): E2eeDeliverySnapshot => ({
      accepted_at: "2026-09-05T00:00:00.000Z",
      ciphertext_bytes: 528,
      claim_id: randomUUID(),
      envelope_bytes: 1_048_576,
      recipient_generation: 1,
      recipient_id: `recipient-${index}`,
      sender_chain_bytes: 1_048_576,
    }),
  );
}

test("snapshot policy bounds 100 recipients to 25 batches and an 8 MiB maximum reservation", (): void => {
  const rows: readonly E2eeDeliverySnapshot[] = parseE2eeDeliverySnapshot(snapshot(100), 100);
  const batches: readonly (readonly E2eeDeliverySnapshot[])[] = e2eeDeliveryBatches(rows);
  expect(batches).toHaveLength(25);
  expect(
    batches.every((batch: readonly E2eeDeliverySnapshot[]): boolean => batch.length === 4),
  ).toBe(true);
  expect<unknown>(batches.flat()).toEqual(rows);
  expect(maximumE2eeCommitBatchBytes(rows)).toBe(8 * 1024 * 1024);
  expect(maximumE2eeCommitBatchBytes([])).toBe(0);
  expect(parseE2eeDeliverySnapshot([], 0)).toEqual([]);
});

test("snapshot policy rejects overflow, incomplete payloads, unsafe sizes and duplicate identities", (): void => {
  const row: E2eeDeliverySnapshot | undefined = snapshot(1)[0];
  if (row === undefined) throw new Error("Snapshot fixture is missing");
  for (const invalid of [
    snapshot(101),
    [{ ...row, envelope_bytes: 1_048_577 }],
    [{ ...row, sender_chain_bytes: 1_048_577 }],
    [{ ...row, envelope_bytes: null }],
    [{ ...row, accepted_at: null }],
    [{ ...row, recipient_generation: "9007199254740992" }],
    [{ ...row, ciphertext_bytes: 0 }],
  ]) {
    expect((): unknown => parseE2eeDeliverySnapshot(invalid, invalid.length)).toThrow();
  }
  expect((): unknown => parseE2eeDeliverySnapshot([row], 0)).toThrow("incomplete");
  expect((): unknown => parseE2eeDeliverySnapshot([row], Number.NaN)).toThrow("incomplete");
  expect((): unknown => parseE2eeDeliverySnapshot([row], -1)).toThrow("incomplete");
  expect((): unknown =>
    parseE2eeDeliverySnapshot([row, { ...row, recipient_id: "other" }], 2),
  ).toThrow("snapshot is invalid");
  expect((): unknown =>
    parseE2eeDeliverySnapshot([row, { ...row, claim_id: randomUUID() }], 2),
  ).toThrow("snapshot is invalid");
});

test("batch validation requires exact snapshot membership, order, generations and UTF-8 byte lengths", (): void => {
  const rows: readonly SqliteE2eeDeliveryRow[] = snapshot(2).map(
    (row: E2eeDeliverySnapshot): SqliteE2eeDeliveryRow => ({
      accepted_at: row.accepted_at,
      ciphertext_bytes: row.ciphertext_bytes,
      claim_id: row.claim_id,
      envelope_json: "🙂",
      recipient_generation: row.recipient_generation,
      recipient_id: row.recipient_id,
      sender_chain_json: "é",
    }),
  );
  const expected: readonly E2eeDeliverySnapshot[] = rows.map(
    (row: SqliteE2eeDeliveryRow): E2eeDeliverySnapshot => ({
      accepted_at: "2026-09-05T00:00:00.000Z",
      ciphertext_bytes: 528,
      claim_id: row.claim_id,
      envelope_bytes: 4,
      recipient_generation: 1,
      recipient_id: row.recipient_id,
      sender_chain_bytes: 2,
    }),
  );
  assertE2eeDeliveryBatch(rows, expected);
  const first: SqliteE2eeDeliveryRow | undefined = rows[0];
  const second: SqliteE2eeDeliveryRow | undefined = rows[1];
  if (first === undefined || second === undefined) throw new Error("Batch fixture is missing");
  const invalidRows: readonly (readonly SqliteE2eeDeliveryRow[])[] = [
    rows.slice(1),
    [second, first],
    [first, { ...second, claim_id: randomUUID() }],
    [first, { ...second, recipient_id: "other" }],
    [first, { ...second, recipient_generation: 2 }],
    [first, { ...second, accepted_at: null }],
    [first, { ...second, ciphertext_bytes: 529 }],
    [first, { ...second, envelope_json: null }],
    [first, { ...second, sender_chain_json: null }],
    [first, { ...second, envelope_json: "longer" }],
    [first, { ...second, sender_chain_json: "longer" }],
    [first, first, first, first, first],
  ];
  for (const invalid of invalidRows) {
    expect((): void => assertE2eeDeliveryBatch(invalid, expected)).toThrow();
  }
});
