import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";

export const MAX_INBOX_PAGE_BYTES: number = 8 * 1024 * 1024;
// A control byte becomes six JSON bytes, seven inside tool text, and six in structuredContent.
export const PLAINTEXT_PAGE_CONTENT_MULTIPLIER: number = 13;
// Stored JSON already escapes controls; its text copy can double escapes plus one structured copy.
export const ENCRYPTED_PAGE_JSON_MULTIPLIER: number = 3;
export const INBOX_PAGE_ROW_OVERHEAD_BYTES: number = 16 * 1024;

export class InboxPageCapacityError extends Error {
  public constructor() {
    super(
      "Inbox page exceeds the response byte budget. Retry get_messages or get_encrypted_messages with a smaller limit (start with 1); inbox resource reads must use these tools instead.",
    );
    this.name = InboxPageCapacityError.name;
  }
}

const ByteCountSchema: z.ZodType<number> = z.union([
  z.number().int().nonnegative().safe(),
  z
    .bigint()
    .nonnegative()
    .max(BigInt(Number.MAX_SAFE_INTEGER))
    .transform((value: bigint): number => Number(value)),
  z
    .string()
    .regex(/^[0-9]{1,16}$/u)
    .transform((value: string): number => Number(value))
    .pipe(z.number().int().nonnegative().safe()),
]);
type PageBudgetRow = { readonly estimated_page_bytes: number };
const PageBudgetRowSchema: z.ZodType<PageBudgetRow> = z.object({
  estimated_page_bytes: ByteCountSchema,
});
export type InboxPageAccounting = {
  readonly kind: "encrypted" | "plaintext";
  readonly limit: number;
};
const InboxPageAccountingSchema: z.ZodType<InboxPageAccounting> = z.strictObject({
  kind: z.enum(["encrypted", "plaintext"]),
  limit: z.number().int().min(1).max(500),
});
const PlaintextAccountingSchema: z.ZodObject<{
  content: z.ZodString;
  message_id: z.ZodString;
  sequence: z.ZodType<number>;
}> = z.object({ content: z.string(), message_id: z.string().uuid(), sequence: ByteCountSchema });
const EncryptedAccountingSchema: z.ZodObject<{
  envelope_json: z.ZodString;
  sender_chain_json: z.ZodString;
  tenant_sequence: z.ZodType<number>;
}> = z.object({
  envelope_json: z.string(),
  sender_chain_json: z.string(),
  tenant_sequence: ByteCountSchema,
});
const EnvelopeIdentitySchema: z.ZodType<{ readonly header: { readonly message_id: string } }> =
  z.object({ header: z.object({ message_id: z.string().uuid() }) });
type InboxRowCost = { readonly bytes: number; readonly id: string; readonly sequence: number };

function inboxRowCost(value: unknown, kind: InboxPageAccounting["kind"]): InboxRowCost {
  if (kind === "plaintext") {
    const row: z.infer<typeof PlaintextAccountingSchema> = PlaintextAccountingSchema.parse(value);
    return {
      bytes:
        INBOX_PAGE_ROW_OVERHEAD_BYTES +
        PLAINTEXT_PAGE_CONTENT_MULTIPLIER * Buffer.byteLength(row.content, "utf8"),
      id: row.message_id.toLowerCase(),
      sequence: row.sequence,
    };
  }
  const row: z.infer<typeof EncryptedAccountingSchema> = EncryptedAccountingSchema.parse(value);
  const envelope: { readonly header: { readonly message_id: string } } =
    EnvelopeIdentitySchema.parse(JSON.parse(row.envelope_json));
  return {
    bytes:
      INBOX_PAGE_ROW_OVERHEAD_BYTES +
      ENCRYPTED_PAGE_JSON_MULTIPLIER *
        (Buffer.byteLength(row.envelope_json, "utf8") +
          Buffer.byteLength(row.sender_chain_json, "utf8")),
    id: envelope.header.message_id.toLowerCase(),
    sequence: row.tenant_sequence,
  };
}

export function requireInboxPageBudget(row: unknown): number {
  const parsed: z.ZodSafeParseResult<PageBudgetRow> = PageBudgetRowSchema.safeParse(row);
  if (!parsed.success) throw new StorageCorruptionError("inbox page byte accounting", parsed.error);
  const estimatedBytes: number = parsed.data.estimated_page_bytes;
  if (estimatedBytes > MAX_INBOX_PAGE_BYTES) throw new InboxPageCapacityError();
  return estimatedBytes;
}

export function requirePostgresInboxPageBudget(input: unknown): number {
  const parsed: z.ZodSafeParseResult<PageBudgetRow[]> = z
    .array(PageBudgetRowSchema)
    .max(500)
    .safeParse(input);
  if (!parsed.success) throw new StorageCorruptionError("inbox page byte accounting", parsed.error);
  const first: PageBudgetRow | undefined = parsed.data[0];
  if (first === undefined) return 0;
  const estimatedBytes: number = requireInboxPageBudget(first);
  if (
    parsed.data.some((row: PageBudgetRow): boolean => row.estimated_page_bytes !== estimatedBytes)
  ) {
    throw new StorageCorruptionError(
      "inbox page byte accounting",
      new Error("Inconsistent page byte totals"),
    );
  }
  return estimatedBytes;
}

export function parsePostgresInboxPage<T>(
  input: unknown,
  rowSchema: z.ZodType<T>,
  accounting: InboxPageAccounting,
): { readonly estimatedBytes: number; readonly rows: T[] } {
  const estimatedBytes: number = requirePostgresInboxPageBudget(input);
  let rawRows: Record<string, unknown>[];
  try {
    const options: InboxPageAccounting = InboxPageAccountingSchema.parse(accounting);
    rawRows = z.array(z.record(z.string(), z.unknown())).max(options.limit).parse(input);
    const ids: Set<string> = new Set<string>();
    let actualBytes: number = 0;
    let previousSequence: number = -1;
    for (const row of rawRows) {
      const cost: InboxRowCost = inboxRowCost(row, options.kind);
      if (ids.has(cost.id) || cost.sequence <= previousSequence) {
        throw new Error("Invalid inbox page identity or order");
      }
      ids.add(cost.id);
      previousSequence = cost.sequence;
      actualBytes += cost.bytes;
    }
    if (!Number.isSafeInteger(actualBytes) || actualBytes !== estimatedBytes) {
      throw new Error("Invalid inbox payload byte total");
    }
  } catch (error: unknown) {
    throw new StorageCorruptionError("inbox page byte accounting", error);
  }
  const rows: T[] = rawRows.map((row: Record<string, unknown>): T => {
    const { estimated_page_bytes: _estimatedBytes, ...payload }: Record<string, unknown> = row;
    return rowSchema.parse(payload);
  });
  return { estimatedBytes, rows };
}
