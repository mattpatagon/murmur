import { expect, test } from "bun:test";
import { z } from "zod";

import {
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
} from "../src/domain/contracts.js";
import {
  AcknowledgeEncryptedMessagesOutputSchema,
  type EncryptedMessageReadReceiptDto,
} from "../src/e2ee/wire-tools.js";

const NOW: string = "2026-08-10T20:00:00.000Z";
const V017MarkMessagesReadOutputSchema: z.ZodType<MarkMessagesReadOutput> = z.strictObject({
  read_at: z.iso.datetime({ offset: true }),
  updated: z.number().int().nonnegative(),
});

function receipts(count: number): readonly EncryptedMessageReadReceiptDto[] {
  return Array.from(
    { length: count },
    (_value: unknown, index: number): EncryptedMessageReadReceiptDto => ({
      message_id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      read_at: NOW,
    }),
  );
}

test("keeps the legacy mark-messages-read output exact", (): void => {
  const legacy: MarkMessagesReadOutput = { read_at: NOW, updated: 1 };
  const newServerOutput: MarkMessagesReadOutput = MarkMessagesReadOutputSchema.parse(legacy);
  expect(V017MarkMessagesReadOutputSchema.parse(newServerOutput)).toEqual(legacy);
  const oldServerOutput: MarkMessagesReadOutput = V017MarkMessagesReadOutputSchema.parse(legacy);
  expect(MarkMessagesReadOutputSchema.parse(oldServerOutput)).toEqual(legacy);
  expect(MarkMessagesReadOutputSchema.safeParse({ ...legacy, receipts: [] }).success).toBe(false);
});

test("bounds and validates encrypted acknowledgement receipts", (): void => {
  const maximum: readonly EncryptedMessageReadReceiptDto[] = receipts(500);
  expect(
    AcknowledgeEncryptedMessagesOutputSchema.safeParse({ receipts: maximum, updated: 500 }).success,
  ).toBe(true);
  expect(
    AcknowledgeEncryptedMessagesOutputSchema.safeParse({ receipts: receipts(501), updated: 501 })
      .success,
  ).toBe(false);
  expect(
    AcknowledgeEncryptedMessagesOutputSchema.safeParse({ receipts: maximum, updated: 499 }).success,
  ).toBe(false);
  const first: EncryptedMessageReadReceiptDto | undefined = maximum[0];
  if (first === undefined) throw new Error("Expected a receipt fixture");
  expect(
    AcknowledgeEncryptedMessagesOutputSchema.safeParse({ receipts: [first, first], updated: 2 })
      .success,
  ).toBe(false);
});
