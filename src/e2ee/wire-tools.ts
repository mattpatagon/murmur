import { z } from "zod";
import { SessionKeyInputSchema } from "../domain/lifecycle-values.js";
import { type SenderAuthority, SenderAuthoritySchema } from "../domain/orchestration.js";

import {
  type EncryptedEnvelopeDto,
  EncryptedEnvelopeDtoSchema,
  type PrekeyCertificateDto,
  type PublicAgentKeyBundleDto,
  PublicAgentKeyBundleDtoSchema,
  type PublicAgentSigningChainDto,
  PublicAgentSigningChainDtoSchema,
} from "./wire-contracts.js";

export const E2EE_WIRE_VERSION: 1 = 1;

const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RepositoryNameSchema: z.ZodString = z
  .string()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u);
const MachineNameSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const ThreadIdSchema: z.ZodString = z.string().min(1).max(200);
const IdempotencyKeySchema: z.ZodString = z.string().min(1).max(200);
const UuidSchema: z.ZodString = z.string().uuid();
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const SequenceSchema: z.ZodNumber = z.number().int().nonnegative().safe();

export type E2eeEntitlementState = "enforced" | "off" | "provisioning";

export type E2eeMessageContextDto = {
  readonly branch: string;
  readonly client: "claude" | "codex" | "connector";
  readonly repository: string;
};

export type E2eeCapabilityOutput = {
  readonly caller_authority: SenderAuthority;
  readonly max_ciphertext_bytes: number;
  readonly max_one_time_prekeys: number;
  readonly protocol: "murmur-e2ee-v1";
  readonly state: E2eeEntitlementState;
  readonly tenant_id: string;
  readonly wire_version: typeof E2EE_WIRE_VERSION;
};

export type E2eeCapabilityConfiguration = Omit<E2eeCapabilityOutput, "caller_authority">;

export type PublishAgentKeyBundleInput = {
  readonly agent_id: string;
  readonly bundle: PublicAgentKeyBundleDto;
  readonly session_key?: string | undefined;
};

export type PublishAgentKeyBundleOutput = {
  readonly agent_id: string;
  readonly fallback_prekey_id: string;
  readonly one_time_prekey_count: number;
  readonly published_at: string;
  readonly root_key_id: string;
};

export type ClaimEncryptionPrekeyInput = {
  readonly context: E2eeMessageContextDto;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly session_key?: string | undefined;
};

export type ClaimedProvenanceDto = {
  readonly message_kind: "message" | "orchestration_request";
  readonly orchestrator_policy_id: string | null;
  readonly sender_authority: "orchestrator" | "peer";
};

export type ClaimEncryptionPrekeyOutput = {
  readonly bundle: PublicAgentKeyBundleDto;
  readonly claim_id: string;
  readonly claimed_at: string;
  readonly expires_at: string;
  readonly prekey_class: "fallback" | "one_time";
  readonly prekey_id: string;
  readonly provenance: ClaimedProvenanceDto;
  readonly recipient_id: string;
};

export type PutEncryptedMessageInput = {
  readonly claim_id: string;
  readonly envelope: EncryptedEnvelopeDto;
};

export type EncryptedMessageDto = {
  readonly envelope: EncryptedEnvelopeDto;
  readonly read_at: string | null;
  readonly sender_chain: PublicAgentSigningChainDto;
  readonly tenant_sequence: number;
};

export type PutEncryptedMessageOutput = {
  readonly duplicate: boolean;
  readonly message: EncryptedMessageDto;
  readonly retention_days: number;
  readonly status: "stored";
};

export type GetEncryptedMessagesInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly limit: number;
  readonly session_key?: string | undefined;
  readonly thread_id?: string | undefined;
  readonly unread_only: boolean;
};

export type EncryptedInboxOutput = {
  readonly agent_id: string;
  readonly inbox_version: number;
  readonly messages: readonly EncryptedMessageDto[];
};

export type WaitForEncryptedMessagesInput = {
  readonly after_sequence: number;
  readonly agent_id: string;
  readonly session_key?: string | undefined;
  readonly timeout_seconds: number;
};

export type WaitForEncryptedMessagesOutput = {
  readonly agent_id: string;
  readonly messages: readonly EncryptedMessageDto[];
  readonly timed_out: boolean;
};

export type EncryptedBroadcastAudienceDto = {
  readonly machine?: string | undefined;
  readonly repository?: string | undefined;
};

export type PrepareEncryptedBroadcastInput = {
  readonly audience: EncryptedBroadcastAudienceDto;
  readonly context: E2eeMessageContextDto;
  readonly idempotency_key?: string | undefined;
  readonly sender_id: string;
  readonly session_key?: string | undefined;
  readonly thread_id?: string | undefined;
};

export type EncryptedBroadcastClaimDto = ClaimEncryptionPrekeyOutput;

export type PrepareEncryptedBroadcastOutput = {
  readonly broadcast_id: string;
  readonly claims: readonly EncryptedBroadcastClaimDto[];
  readonly duplicate: boolean;
  readonly expires_at: string;
  readonly recipient_count: number;
  readonly thread_id: string;
};

export type PutEncryptedBroadcastDeliveryInput = {
  readonly broadcast_id: string;
  readonly claim_id: string;
  readonly envelope: EncryptedEnvelopeDto;
};

export type PutEncryptedBroadcastDeliveryOutput = {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly recipient_id: string;
};

export type CommitEncryptedBroadcastInput = { readonly broadcast_id: string };
export type CommitEncryptedBroadcastOutput = {
  readonly broadcast_id: string;
  readonly committed_at: string;
  readonly duplicate: boolean;
  readonly recipient_count: number;
  readonly status: "stored";
};

export type CancelEncryptedBroadcastInput = { readonly broadcast_id: string };
export type CancelEncryptedBroadcastOutput = { readonly cancelled: boolean };

export type GetInboxSummaryInput = {
  readonly agent_id: string;
  readonly session_key?: string | undefined;
};
export type GetInboxSummaryOutput = {
  readonly agent_id: string;
  readonly inbox_version: number;
  readonly newest_sequence: number | null;
  readonly unread_count: number;
};

export const E2eeMessageContextDtoSchema: z.ZodType<E2eeMessageContextDto> = z.strictObject({
  branch: z.string().min(1).max(500),
  client: z.enum(["claude", "codex", "connector"]),
  repository: RepositoryNameSchema,
});
export const E2eeCapabilityInputSchema: z.ZodType<Record<string, never>> = z.strictObject({});
export const E2eeCapabilityOutputSchema: z.ZodType<E2eeCapabilityOutput> = z.strictObject({
  caller_authority: SenderAuthoritySchema,
  max_ciphertext_bytes: z.number().int().positive().safe(),
  max_one_time_prekeys: z.number().int().positive().max(100),
  protocol: z.literal("murmur-e2ee-v1"),
  state: z.enum(["enforced", "off", "provisioning"]),
  tenant_id: UuidSchema,
  wire_version: z.literal(E2EE_WIRE_VERSION),
});
export const PublishAgentKeyBundleInputSchema: z.ZodType<PublishAgentKeyBundleInput> = z
  .strictObject({
    agent_id: AgentIdSchema,
    bundle: PublicAgentKeyBundleDtoSchema,
    session_key: SessionKeyInputSchema.optional(),
  })
  .superRefine((input: PublishAgentKeyBundleInput, context: z.core.$RefinementCtx): void => {
    if (input.agent_id !== input.bundle.agent_certificate.agent_id) {
      context.addIssue({ code: "custom", message: "Published bundle agent identity mismatch" });
    }
  });
export const PublishAgentKeyBundleOutputSchema: z.ZodType<PublishAgentKeyBundleOutput> =
  z.strictObject({
    agent_id: AgentIdSchema,
    fallback_prekey_id: z.string().regex(/^mpk_[A-Za-z0-9_-]{43}$/u),
    one_time_prekey_count: z.number().int().nonnegative().max(100),
    published_at: InstantSchema,
    root_key_id: z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u),
  });
export const ClaimedProvenanceDtoSchema: z.ZodType<ClaimedProvenanceDto> = z
  .strictObject({
    message_kind: z.enum(["message", "orchestration_request"]),
    orchestrator_policy_id: UuidSchema.nullable(),
    sender_authority: z.enum(["orchestrator", "peer"]),
  })
  .superRefine((value: ClaimedProvenanceDto, context: z.core.$RefinementCtx): void => {
    const isOrchestration: boolean = value.message_kind === "orchestration_request";
    if (isOrchestration && value.sender_authority !== "peer") {
      context.addIssue({
        code: "custom",
        message: "Orchestration requests must originate from peer authority",
      });
    }
    if (isOrchestration !== (value.orchestrator_policy_id !== null)) {
      context.addIssue({ code: "custom", message: "Claimed policy provenance is inconsistent" });
    }
  });
export const ClaimEncryptionPrekeyInputSchema: z.ZodType<ClaimEncryptionPrekeyInput> =
  z.strictObject({
    context: E2eeMessageContextDtoSchema,
    recipient_id: AgentIdSchema,
    sender_id: AgentIdSchema,
    session_key: SessionKeyInputSchema.optional(),
  });
export const ClaimEncryptionPrekeyOutputSchema: z.ZodType<ClaimEncryptionPrekeyOutput> = z
  .strictObject({
    bundle: PublicAgentKeyBundleDtoSchema,
    claim_id: UuidSchema,
    claimed_at: InstantSchema,
    expires_at: InstantSchema,
    prekey_class: z.enum(["fallback", "one_time"]),
    prekey_id: z.string().regex(/^mpk_[A-Za-z0-9_-]{43}$/u),
    provenance: ClaimedProvenanceDtoSchema,
    recipient_id: AgentIdSchema,
  })
  .superRefine((claim: ClaimEncryptionPrekeyOutput, context: z.core.$RefinementCtx): void => {
    if (claim.recipient_id !== claim.bundle.agent_certificate.agent_id) {
      context.addIssue({ code: "custom", message: "Claim recipient identity mismatch" });
    }
    const claimedIds: readonly string[] =
      claim.prekey_class === "fallback"
        ? [claim.bundle.fallback_prekey.prekey_id]
        : claim.bundle.one_time_prekeys.map(
            (prekey: PrekeyCertificateDto): string => prekey.prekey_id,
          );
    if (!claimedIds.includes(claim.prekey_id)) {
      context.addIssue({ code: "custom", message: "Claimed prekey is absent from its bundle" });
    }
  });
export const EncryptedMessageDtoSchema: z.ZodType<EncryptedMessageDto> = z.strictObject({
  envelope: EncryptedEnvelopeDtoSchema,
  read_at: InstantSchema.nullable(),
  sender_chain: PublicAgentSigningChainDtoSchema,
  tenant_sequence: SequenceSchema.positive(),
});
export const PutEncryptedMessageInputSchema: z.ZodType<PutEncryptedMessageInput> = z.strictObject({
  claim_id: UuidSchema,
  envelope: EncryptedEnvelopeDtoSchema,
});
export const PutEncryptedMessageOutputSchema: z.ZodType<PutEncryptedMessageOutput> = z.strictObject(
  {
    duplicate: z.boolean(),
    message: EncryptedMessageDtoSchema,
    retention_days: z.number().int().positive().safe(),
    status: z.literal("stored"),
  },
);
export const GetEncryptedMessagesInputSchema: z.ZodType<GetEncryptedMessagesInput> = z.strictObject(
  {
    after_sequence: SequenceSchema,
    agent_id: AgentIdSchema,
    limit: z.number().int().min(1).max(500),
    session_key: SessionKeyInputSchema.optional(),
    thread_id: ThreadIdSchema.optional(),
    unread_only: z.boolean(),
  },
);
export const EncryptedInboxOutputSchema: z.ZodType<EncryptedInboxOutput> = z.strictObject({
  agent_id: AgentIdSchema,
  inbox_version: SequenceSchema,
  messages: z.array(EncryptedMessageDtoSchema).max(500),
});
export const WaitForEncryptedMessagesInputSchema: z.ZodType<WaitForEncryptedMessagesInput> =
  z.strictObject({
    after_sequence: SequenceSchema,
    agent_id: AgentIdSchema,
    session_key: SessionKeyInputSchema.optional(),
    timeout_seconds: z.number().int().min(1).max(25),
  });
export const WaitForEncryptedMessagesOutputSchema: z.ZodType<WaitForEncryptedMessagesOutput> =
  z.strictObject({
    agent_id: AgentIdSchema,
    messages: z.array(EncryptedMessageDtoSchema).max(500),
    timed_out: z.boolean(),
  });
export const EncryptedBroadcastAudienceDtoSchema: z.ZodType<EncryptedBroadcastAudienceDto> =
  z.strictObject({
    machine: MachineNameSchema.optional(),
    repository: RepositoryNameSchema.optional(),
  });
export const PrepareEncryptedBroadcastInputSchema: z.ZodType<PrepareEncryptedBroadcastInput> =
  z.strictObject({
    audience: EncryptedBroadcastAudienceDtoSchema,
    context: E2eeMessageContextDtoSchema,
    idempotency_key: IdempotencyKeySchema.optional(),
    sender_id: AgentIdSchema,
    session_key: SessionKeyInputSchema.optional(),
    thread_id: ThreadIdSchema.optional(),
  });
export const EncryptedBroadcastClaimDtoSchema: z.ZodType<EncryptedBroadcastClaimDto> =
  ClaimEncryptionPrekeyOutputSchema;
export const PrepareEncryptedBroadcastOutputSchema: z.ZodType<PrepareEncryptedBroadcastOutput> = z
  .strictObject({
    broadcast_id: UuidSchema,
    claims: z.array(EncryptedBroadcastClaimDtoSchema).max(100),
    duplicate: z.boolean(),
    expires_at: InstantSchema,
    recipient_count: z.number().int().nonnegative().max(100),
    thread_id: ThreadIdSchema,
  })
  .superRefine((value: PrepareEncryptedBroadcastOutput, context: z.core.$RefinementCtx): void => {
    if (value.claims.length !== value.recipient_count) {
      context.addIssue({ code: "custom", message: "Broadcast claim count mismatch" });
    }
    const recipients: readonly string[] = value.claims.map(
      (claim: EncryptedBroadcastClaimDto): string => claim.recipient_id,
    );
    for (let index: number = 1; index < recipients.length; index += 1) {
      const previous: string | undefined = recipients[index - 1];
      const current: string | undefined = recipients[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({ code: "custom", message: "Broadcast claims must be sorted and unique" });
        break;
      }
    }
  });
export const PutEncryptedBroadcastDeliveryInputSchema: z.ZodType<PutEncryptedBroadcastDeliveryInput> =
  z.strictObject({
    broadcast_id: UuidSchema,
    claim_id: UuidSchema,
    envelope: EncryptedEnvelopeDtoSchema,
  });
export const PutEncryptedBroadcastDeliveryOutputSchema: z.ZodType<PutEncryptedBroadcastDeliveryOutput> =
  z.strictObject({
    accepted: z.boolean(),
    duplicate: z.boolean(),
    recipient_id: AgentIdSchema,
  });
export const CommitEncryptedBroadcastInputSchema: z.ZodType<CommitEncryptedBroadcastInput> =
  z.strictObject({ broadcast_id: UuidSchema });
export const CommitEncryptedBroadcastOutputSchema: z.ZodType<CommitEncryptedBroadcastOutput> =
  z.strictObject({
    broadcast_id: UuidSchema,
    committed_at: InstantSchema,
    duplicate: z.boolean(),
    recipient_count: z.number().int().nonnegative().max(100),
    status: z.literal("stored"),
  });
export const CancelEncryptedBroadcastInputSchema: z.ZodType<CancelEncryptedBroadcastInput> =
  z.strictObject({ broadcast_id: UuidSchema });
export const CancelEncryptedBroadcastOutputSchema: z.ZodType<CancelEncryptedBroadcastOutput> =
  z.strictObject({ cancelled: z.boolean() });
export const GetInboxSummaryInputSchema: z.ZodType<GetInboxSummaryInput> = z.strictObject({
  agent_id: AgentIdSchema,
  session_key: SessionKeyInputSchema.optional(),
});
export const GetInboxSummaryOutputSchema: z.ZodType<GetInboxSummaryOutput> = z.strictObject({
  agent_id: AgentIdSchema,
  inbox_version: SequenceSchema,
  newest_sequence: SequenceSchema.positive().nullable(),
  unread_count: z.number().int().nonnegative().safe(),
});
