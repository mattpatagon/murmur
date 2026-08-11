import { z } from "zod";

import { SenderAuthoritySchema } from "../domain/orchestration.js";

const DatabaseIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)), {
    message: "Postgres integer exceeds JavaScript's safe integer range",
  })
  .transform((value: bigint | number | string): number => Number(value));

export type PostgresE2eeAgentRow = {
  readonly authority: "orchestrator" | "peer";
  readonly generation: number;
};

export type PostgresE2eeBundleRow = {
  readonly agent_generation: number;
  readonly bundle_json: string;
  readonly published_at: string;
};

export type PostgresE2eePrekeyRow = {
  readonly certificate_json: string;
  readonly prekey_class: "fallback" | "one_time";
  readonly prekey_id: string;
};

export type PostgresE2eeClaimRow = {
  readonly broadcast_id: string | null;
  readonly claim_json: string;
  readonly consumed_at: string | null;
  readonly expires_at: string;
  readonly orchestrator_token_id: string | null;
  readonly recipient_generation: number;
  readonly request_json: string;
  readonly sender_generation: number;
};

export type PostgresE2eeMessageRow = {
  readonly envelope_json: string;
  readonly read_at: string | null;
  readonly sender_chain_json: string;
  readonly tenant_sequence: number;
};

export type PostgresE2eeSummaryRow = {
  readonly newest_sequence: number | null;
  readonly unread_count: number;
  readonly version: number;
};

export type PostgresE2eeBroadcastRow = {
  readonly broadcast_id: string;
  readonly committed_at: string | null;
  readonly expires_at: string;
  readonly recipient_count: number;
  readonly request_json: string;
  readonly sender_authority: "orchestrator" | "peer";
  readonly sender_generation: number;
  readonly sender_id: string;
  readonly state: "cancelled" | "committed" | "pending";
  readonly thread_id: string;
};

export type PostgresE2eeDeliveryRow = {
  readonly accepted_at: string | null;
  readonly ciphertext_bytes: number | null;
  readonly claim_id: string;
  readonly envelope_json: string | null;
  readonly recipient_generation: number;
  readonly recipient_id: string;
  readonly sender_chain_json: string | null;
};

export const PostgresE2eeAgentRowSchema: z.ZodType<PostgresE2eeAgentRow> = z.strictObject({
  authority: SenderAuthoritySchema,
  generation: DatabaseIntegerSchema.pipe(z.number().positive()),
});

export const PostgresE2eeBundleRowSchema: z.ZodType<PostgresE2eeBundleRow> = z.strictObject({
  agent_generation: DatabaseIntegerSchema.pipe(z.number().positive()),
  bundle_json: z.string(),
  published_at: z.string(),
});

export const PostgresE2eePrekeyRowSchema: z.ZodType<PostgresE2eePrekeyRow> = z.strictObject({
  certificate_json: z.string(),
  prekey_class: z.enum(["fallback", "one_time"]),
  prekey_id: z.string(),
});

export const PostgresE2eeClaimRowSchema: z.ZodType<PostgresE2eeClaimRow> = z.strictObject({
  broadcast_id: z.string().uuid().nullable(),
  claim_json: z.string(),
  consumed_at: z.string().nullable(),
  expires_at: z.string(),
  orchestrator_token_id: z.string().uuid().nullable(),
  recipient_generation: DatabaseIntegerSchema.pipe(z.number().positive()),
  request_json: z.string(),
  sender_generation: DatabaseIntegerSchema.pipe(z.number().positive()),
});

export const PostgresE2eeMessageRowSchema: z.ZodType<PostgresE2eeMessageRow> = z.strictObject({
  envelope_json: z.string(),
  read_at: z.string().nullable(),
  sender_chain_json: z.string(),
  tenant_sequence: DatabaseIntegerSchema.pipe(z.number().positive()),
});

export const PostgresE2eeCountRowSchema: z.ZodType<{ readonly count: number }> = z.strictObject({
  count: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

export const PostgresE2eeVersionRowSchema: z.ZodType<{ readonly version: number }> = z.strictObject(
  {
    version: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
  },
);

export const PostgresE2eeSummaryRowSchema: z.ZodType<PostgresE2eeSummaryRow> = z.strictObject({
  newest_sequence: DatabaseIntegerSchema.pipe(z.number().positive()).nullable(),
  unread_count: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
  version: DatabaseIntegerSchema.pipe(z.number().nonnegative()),
});

export const PostgresE2eeBroadcastRowSchema: z.ZodType<PostgresE2eeBroadcastRow> = z.strictObject({
  broadcast_id: z.string().uuid(),
  committed_at: z.string().nullable(),
  expires_at: z.string(),
  recipient_count: DatabaseIntegerSchema.pipe(z.number().min(0).max(100)),
  request_json: z.string(),
  sender_authority: z.enum(["peer", "orchestrator"]),
  sender_generation: DatabaseIntegerSchema.pipe(z.number().positive()),
  sender_id: z.string(),
  state: z.enum(["cancelled", "committed", "pending"]),
  thread_id: z.string(),
});

export const PostgresE2eeDeliveryRowSchema: z.ZodType<PostgresE2eeDeliveryRow> = z.strictObject({
  accepted_at: z.string().nullable(),
  ciphertext_bytes: DatabaseIntegerSchema.pipe(z.number().positive()).nullable(),
  claim_id: z.string().uuid(),
  envelope_json: z.string().nullable(),
  recipient_generation: DatabaseIntegerSchema.pipe(z.number().positive()),
  recipient_id: z.string(),
  sender_chain_json: z.string().nullable(),
});
