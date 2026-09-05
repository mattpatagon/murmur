import { z } from "zod";

import {
  type EncryptedEnvelopeDto,
  EncryptedEnvelopeDtoSchema,
  type PublicAgentSigningChainDto,
  PublicAgentSigningChainDtoSchema,
} from "../e2ee/wire-contracts.js";
import { encryptedCiphertextBytes } from "./e2ee-store-validation.js";

export const E2EE_BROADCAST_COMMIT_BATCH_SIZE: number = 4;
export const E2EE_BROADCAST_COMMIT_SNAPSHOT_LIMIT: number = 101;
export const E2EE_BROADCAST_COMMIT_JSON_BYTES: number = 1_048_576;

const IntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .transform((value: string | number | bigint): number => Number(value))
  .pipe(z.number().int().positive().safe());

export type E2eeDeliverySnapshot = {
  readonly accepted_at: string;
  readonly ciphertext_bytes: number;
  readonly claim_id: string;
  readonly envelope_bytes: number;
  readonly recipient_generation: number;
  readonly recipient_id: string;
  readonly sender_chain_bytes: number;
};

const SnapshotSchema: z.ZodType<E2eeDeliverySnapshot> = z.strictObject({
  accepted_at: z.string(),
  ciphertext_bytes: IntegerSchema,
  claim_id: z.string().uuid(),
  envelope_bytes: IntegerSchema.pipe(z.number().max(E2EE_BROADCAST_COMMIT_JSON_BYTES)),
  recipient_generation: IntegerSchema,
  recipient_id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  sender_chain_bytes: IntegerSchema.pipe(z.number().max(E2EE_BROADCAST_COMMIT_JSON_BYTES)),
});

export function parseE2eeDeliverySnapshot(
  raw: unknown,
  recipientCount: number,
): readonly E2eeDeliverySnapshot[] {
  const parsed: z.ZodSafeParseResult<E2eeDeliverySnapshot[]> = z
    .array(SnapshotSchema)
    .max(100)
    .safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "Encrypted broadcast delivery set is incomplete or exceeds its stored JSON limit",
    );
  }
  const rows: E2eeDeliverySnapshot[] = parsed.data;
  if (
    !Number.isSafeInteger(recipientCount) ||
    recipientCount < 0 ||
    rows.length !== recipientCount
  ) {
    throw new Error("Encrypted broadcast delivery set is incomplete");
  }
  if (
    new Set(rows.map((row: E2eeDeliverySnapshot): string => row.claim_id)).size !== rows.length ||
    new Set(rows.map((row: E2eeDeliverySnapshot): string => row.recipient_id)).size !== rows.length
  ) {
    throw new Error("Encrypted broadcast delivery snapshot is invalid");
  }
  return rows;
}

export function e2eeDeliveryBatches(
  snapshot: readonly E2eeDeliverySnapshot[],
): readonly (readonly E2eeDeliverySnapshot[])[] {
  const batches: E2eeDeliverySnapshot[][] = [];
  for (
    let offset: number = 0;
    offset < snapshot.length;
    offset += E2EE_BROADCAST_COMMIT_BATCH_SIZE
  ) {
    batches.push(snapshot.slice(offset, offset + E2EE_BROADCAST_COMMIT_BATCH_SIZE));
  }
  return batches;
}

export function maximumE2eeCommitBatchBytes(snapshot: readonly E2eeDeliverySnapshot[]): number {
  return Math.max(
    0,
    ...e2eeDeliveryBatches(snapshot).map((batch: readonly E2eeDeliverySnapshot[]): number =>
      batch.reduce(
        (total: number, row: E2eeDeliverySnapshot): number =>
          total + row.envelope_bytes + row.sender_chain_bytes,
        0,
      ),
    ),
  );
}

type CommitDelivery = {
  readonly accepted_at: string | null;
  readonly ciphertext_bytes: number | null;
  readonly claim_id: string;
  readonly envelope_json: string | null;
  readonly recipient_generation: number;
  readonly recipient_id: string;
  readonly sender_chain_json: string | null;
};

export function assertE2eeDeliveryBatch(
  rows: readonly CommitDelivery[],
  snapshot: readonly E2eeDeliverySnapshot[],
): void {
  if (rows.length !== snapshot.length || rows.length > E2EE_BROADCAST_COMMIT_BATCH_SIZE) {
    throw new Error("Encrypted broadcast delivery batch is incomplete");
  }
  for (const [index, row] of rows.entries()) {
    const expected: E2eeDeliverySnapshot | undefined = snapshot[index];
    if (
      expected === undefined ||
      row.claim_id !== expected.claim_id ||
      row.recipient_id !== expected.recipient_id ||
      row.recipient_generation !== expected.recipient_generation ||
      row.accepted_at !== expected.accepted_at ||
      row.ciphertext_bytes !== expected.ciphertext_bytes ||
      row.envelope_json === null ||
      row.sender_chain_json === null ||
      Buffer.byteLength(row.envelope_json, "utf8") !== expected.envelope_bytes ||
      Buffer.byteLength(row.sender_chain_json, "utf8") !== expected.sender_chain_bytes
    ) {
      throw new Error("Encrypted broadcast delivery no longer matches its snapshot");
    }
  }
}

type CommitBroadcast = {
  readonly broadcast_id: string;
  readonly sender_authority: "peer" | "orchestrator";
  readonly sender_id: string;
  readonly thread_id: string;
};

export function validatedE2eeBroadcastDelivery(
  delivery: CommitDelivery,
  broadcast: CommitBroadcast,
): { readonly envelope: EncryptedEnvelopeDto; readonly senderChain: PublicAgentSigningChainDto } {
  if (
    delivery.envelope_json === null ||
    delivery.sender_chain_json === null ||
    delivery.ciphertext_bytes === null
  ) {
    throw new Error("Encrypted broadcast delivery set is incomplete");
  }
  const envelope: EncryptedEnvelopeDto = EncryptedEnvelopeDtoSchema.parse(
    JSON.parse(delivery.envelope_json),
  );
  if (
    envelope.header.broadcast_id !== broadcast.broadcast_id ||
    envelope.header.thread_id !== broadcast.thread_id ||
    envelope.header.sender_id !== broadcast.sender_id ||
    envelope.header.sender_authority !== broadcast.sender_authority ||
    envelope.header.recipient_id !== delivery.recipient_id ||
    envelope.header.message_kind !== "message" ||
    envelope.header.orchestrator_policy_id !== null ||
    encryptedCiphertextBytes(envelope) !== delivery.ciphertext_bytes
  ) {
    throw new Error("Encrypted broadcast delivery no longer matches its snapshot");
  }
  return {
    envelope,
    senderChain: PublicAgentSigningChainDtoSchema.parse(JSON.parse(delivery.sender_chain_json)),
  };
}
