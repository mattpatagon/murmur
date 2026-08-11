import { z } from "zod";

const SqliteIntegerSchema: z.ZodPipe<
  z.ZodUnion<readonly [z.ZodNumber, z.ZodBigInt]>,
  z.ZodTransform<number, number | bigint>
> = z
  .union([z.number().int(), z.bigint()])
  .transform((value: number | bigint): number => Number(value));

export type SqliteE2eeAgentRow = {
  readonly agent_id: string;
  readonly generation: number;
};

export const SqliteE2eeAgentRowSchema: z.ZodType<SqliteE2eeAgentRow> = z.strictObject({
  agent_id: z.string(),
  generation: SqliteIntegerSchema,
});

export type SqliteE2eeBundleRow = {
  readonly agent_generation: number;
  readonly bundle_json: string;
  readonly published_at: string;
};

export const SqliteE2eeBundleRowSchema: z.ZodType<SqliteE2eeBundleRow> = z.strictObject({
  agent_generation: SqliteIntegerSchema,
  bundle_json: z.string(),
  published_at: z.string(),
});

export type SqliteE2eeClaimRow = {
  readonly broadcast_id: string | null;
  readonly claim_json: string;
  readonly consumed_at: string | null;
  readonly expires_at: string;
  readonly recipient_generation: number;
  readonly request_json: string;
  readonly sender_generation: number;
};

export const SqliteE2eeClaimRowSchema: z.ZodType<SqliteE2eeClaimRow> = z.strictObject({
  broadcast_id: z.string().nullable(),
  claim_json: z.string(),
  consumed_at: z.string().nullable(),
  expires_at: z.string(),
  recipient_generation: SqliteIntegerSchema,
  request_json: z.string(),
  sender_generation: SqliteIntegerSchema,
});

export type SqliteE2eeMessageRow = {
  readonly envelope_json: string;
  readonly read_at: string | null;
  readonly sender_chain_json: string;
  readonly sequence: number;
};

export const SqliteE2eeMessageRowSchema: z.ZodType<SqliteE2eeMessageRow> = z.strictObject({
  envelope_json: z.string(),
  read_at: z.string().nullable(),
  sender_chain_json: z.string(),
  sequence: SqliteIntegerSchema,
});

export type SqliteE2eeBroadcastRow = {
  readonly broadcast_id: string;
  readonly committed_at: string | null;
  readonly expires_at: string;
  readonly recipient_count: number;
  readonly request_json: string;
  readonly sender_generation: number;
  readonly sender_authority: "orchestrator" | "peer";
  readonly sender_id: string;
  readonly state: "cancelled" | "committed" | "pending";
  readonly thread_id: string;
};

export const SqliteE2eeBroadcastRowSchema: z.ZodType<SqliteE2eeBroadcastRow> = z.strictObject({
  broadcast_id: z.string(),
  committed_at: z.string().nullable(),
  expires_at: z.string(),
  recipient_count: SqliteIntegerSchema,
  request_json: z.string(),
  sender_generation: SqliteIntegerSchema,
  sender_authority: z.enum(["peer", "orchestrator"]),
  sender_id: z.string(),
  state: z.enum(["cancelled", "committed", "pending"]),
  thread_id: z.string(),
});

export type SqliteE2eeDeliveryRow = {
  readonly accepted_at: string | null;
  readonly ciphertext_bytes: number | null;
  readonly claim_id: string;
  readonly envelope_json: string | null;
  readonly recipient_generation: number;
  readonly recipient_id: string;
  readonly sender_chain_json: string | null;
};

export const SqliteE2eeDeliveryRowSchema: z.ZodType<SqliteE2eeDeliveryRow> = z.strictObject({
  accepted_at: z.string().nullable(),
  ciphertext_bytes: SqliteIntegerSchema.nullable(),
  claim_id: z.string(),
  envelope_json: z.string().nullable(),
  recipient_generation: SqliteIntegerSchema,
  recipient_id: z.string(),
  sender_chain_json: z.string().nullable(),
});

export type SqliteE2eeCountRow = { readonly count: number };
export const SqliteE2eeCountRowSchema: z.ZodType<SqliteE2eeCountRow> = z.strictObject({
  count: SqliteIntegerSchema,
});

export type SqliteE2eeVersionRow = {
  readonly newest_sequence: number | null;
  readonly unread_count: number;
  readonly version: number;
};

export const SqliteE2eeVersionRowSchema: z.ZodType<SqliteE2eeVersionRow> = z.strictObject({
  newest_sequence: SqliteIntegerSchema.nullable(),
  unread_count: SqliteIntegerSchema,
  version: SqliteIntegerSchema,
});
