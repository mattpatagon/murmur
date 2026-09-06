import { expect, test } from "bun:test";

import { parsePostgresInboxPage } from "../src/storage/inbox-page-budget.js";
import {
  type PostgresE2eeMessageRow,
  PostgresE2eeMessageRowSchema,
} from "../src/storage/postgres-e2ee-rows.js";
import { type MessageRow, MessageRowSchema } from "../src/storage/postgres-message-rows.js";

const CORRUPTION: string = "Stored inbox page byte accounting failed runtime validation";
const MESSAGE_ID: string = "abcdef00-0000-4000-8000-000000000001";

function plaintextRow(sequence: number, messageId: string = MESSAGE_ID): MessageRow {
  return {
    branch_name: "main",
    broadcast_id: null,
    client_name: "codex",
    content: "\u0001漢 ",
    created_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-31T00:00:00.000Z",
    message_id: messageId,
    message_kind: "message",
    orchestrator_policy_id: null,
    read_at: null,
    recipient_id: "reader",
    recipient_generation: 1,
    repository_name: "test/accounting",
    sender_id: "sender",
    sender_generation: 1,
    sender_authority: "peer",
    sequence,
    thread_id: "thread",
  };
}

function encryptedRow(sequence: number, messageId: string = MESSAGE_ID): PostgresE2eeMessageRow {
  return {
    envelope_json: JSON.stringify({ header: { message_id: messageId }, ciphertext: "AAAA" }),
    read_at: null,
    sender_chain_json: '{ "root_key_id": "fixture" }',
    tenant_sequence: sequence,
  };
}

function plaintextBytes(row: MessageRow): number {
  return 16_384 + 13 * Buffer.byteLength(row.content, "utf8");
}

function encryptedBytes(row: PostgresE2eeMessageRow): number {
  return (
    16_384 +
    3 *
      (Buffer.byteLength(row.envelope_json, "utf8") +
        Buffer.byteLength(row.sender_chain_json, "utf8"))
  );
}

test("nonempty plaintext rows cannot claim zero or underreported retained bytes", (): void => {
  const row: MessageRow = plaintextRow(1);
  expect(MessageRowSchema.parse(row)).toEqual(row);
  for (const cost of [0, plaintextBytes(row) - 1, plaintextBytes(row) + 1]) {
    expect((): void => {
      parsePostgresInboxPage([{ ...row, estimated_page_bytes: cost }], MessageRowSchema, {
        kind: "plaintext",
        limit: 500,
      });
    }).toThrow(CORRUPTION);
  }
});

test("encrypted rows cannot claim less than their raw stored JSON byte cost", (): void => {
  const row: PostgresE2eeMessageRow = encryptedRow(1);
  expect(PostgresE2eeMessageRowSchema.parse(row)).toEqual(row);
  for (const cost of [0, encryptedBytes(row) - 1, encryptedBytes(row) + 1]) {
    expect((): void => {
      parsePostgresInboxPage(
        [{ ...row, estimated_page_bytes: cost }],
        PostgresE2eeMessageRowSchema,
        {
          kind: "encrypted",
          limit: 500,
        },
      );
    }).toThrow(CORRUPTION);
  }
});

test("duplicate plaintext and encrypted message UUIDs cannot consume two page positions", (): void => {
  const first: MessageRow = plaintextRow(1);
  const second: MessageRow = plaintextRow(2, MESSAGE_ID.toUpperCase());
  const total: number = plaintextBytes(first) + plaintextBytes(second);
  expect((): void => {
    parsePostgresInboxPage(
      [first, second].map((row: MessageRow): object => ({ ...row, estimated_page_bytes: total })),
      MessageRowSchema,
      { kind: "plaintext", limit: 500 },
    );
  }).toThrow(CORRUPTION);
  const encrypted: PostgresE2eeMessageRow[] = [encryptedRow(1), encryptedRow(2)];
  const encryptedTotal: number = encrypted.reduce(
    (bytes: number, row: PostgresE2eeMessageRow): number => bytes + encryptedBytes(row),
    0,
  );
  expect((): void => {
    parsePostgresInboxPage(
      encrypted.map((row: PostgresE2eeMessageRow): object => ({
        ...row,
        estimated_page_bytes: encryptedTotal,
      })),
      PostgresE2eeMessageRowSchema,
      { kind: "encrypted", limit: 500 },
    );
  }).toThrow(CORRUPTION);
});

test("exact raw costs preserve whitespace, Unicode and integer encodings without exposing headers", (): void => {
  const row: MessageRow = plaintextRow(1);
  for (const total of [
    plaintextBytes(row),
    String(plaintextBytes(row)),
    BigInt(plaintextBytes(row)),
  ]) {
    expect(
      parsePostgresInboxPage([{ ...row, estimated_page_bytes: total }], MessageRowSchema, {
        kind: "plaintext",
        limit: 1,
      }),
    ).toEqual({ estimatedBytes: plaintextBytes(row), rows: [row] });
  }
  const encrypted: PostgresE2eeMessageRow = encryptedRow(1);
  expect(
    parsePostgresInboxPage(
      [{ ...encrypted, estimated_page_bytes: encryptedBytes(encrypted) }],
      PostgresE2eeMessageRowSchema,
      {
        kind: "encrypted",
        limit: 1,
      },
    ),
  ).toEqual({ estimatedBytes: encryptedBytes(encrypted), rows: [encrypted] });
  const compact: number =
    16_384 +
    3 *
      (Buffer.byteLength(JSON.stringify(JSON.parse(encrypted.envelope_json)), "utf8") +
        Buffer.byteLength(JSON.stringify(JSON.parse(encrypted.sender_chain_json)), "utf8"));
  expect(compact).toBeLessThan(encryptedBytes(encrypted));
  expect((): void => {
    parsePostgresInboxPage(
      [{ ...encrypted, estimated_page_bytes: compact }],
      PostgresE2eeMessageRowSchema,
      {
        kind: "encrypted",
        limit: 1,
      },
    );
  }).toThrow(CORRUPTION);
});

test("inbox accounting rejects duplicate or reversed sequences and excess rows", (): void => {
  const first: MessageRow = plaintextRow(1);
  const nextId: string = "abcdef00-0000-4000-8000-000000000002";
  for (const sequence of [0, 1]) {
    const second: MessageRow = plaintextRow(sequence, nextId);
    expect((): void => {
      parsePostgresInboxPage(
        [first, second].map((row: MessageRow): object => ({
          ...row,
          estimated_page_bytes: plaintextBytes(row) * 2,
        })),
        MessageRowSchema,
        { kind: "plaintext", limit: 2 },
      );
    }).toThrow(CORRUPTION);
  }
  for (const count of [2, 501]) {
    expect((): void => {
      parsePostgresInboxPage(
        Array.from({ length: count }, (): object => ({
          ...first,
          estimated_page_bytes: plaintextBytes(first) * count,
        })),
        MessageRowSchema,
        { kind: "plaintext", limit: 1 },
      );
    }).toThrow(CORRUPTION);
  }
  for (const limit of [0, 501, 1.5]) {
    expect((): void => {
      parsePostgresInboxPage([], MessageRowSchema, { kind: "plaintext", limit });
    }).toThrow(CORRUPTION);
  }
  expect(parsePostgresInboxPage([], MessageRowSchema, { kind: "plaintext", limit: 1 })).toEqual({
    estimatedBytes: 0,
    rows: [],
  });
});

test("encrypted envelope identities and sequence order are validated before returning payloads", (): void => {
  const first: PostgresE2eeMessageRow = encryptedRow(2);
  for (const row of [
    { ...first, envelope_json: "private-invalid-json" },
    { ...first, envelope_json: '{"header":{"message_id":"invalid"}}' },
    { ...first, tenant_sequence: -1 },
  ]) {
    expect((): void => {
      parsePostgresInboxPage(
        [{ ...row, estimated_page_bytes: encryptedBytes(row) }],
        PostgresE2eeMessageRowSchema,
        {
          kind: "encrypted",
          limit: 1,
        },
      );
    }).toThrow(CORRUPTION);
  }
  const second: PostgresE2eeMessageRow = encryptedRow(1, "abcdef00-0000-4000-8000-000000000002");
  const bytes: number = encryptedBytes(first) + encryptedBytes(second);
  expect((): void => {
    parsePostgresInboxPage(
      [first, second].map((row: PostgresE2eeMessageRow): object => ({
        ...row,
        estimated_page_bytes: bytes,
      })),
      PostgresE2eeMessageRowSchema,
      { kind: "encrypted", limit: 2 },
    );
  }).toThrow(CORRUPTION);
});
