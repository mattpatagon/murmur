import { z } from "zod";

import { AgentClientNameSchema } from "../domain/client-provenance.js";
import type { MessageContextDto } from "../domain/contracts.js";
import {
  type EffectiveOrchestratorDto,
  EffectiveOrchestratorDtoSchema,
} from "../hosted/orchestration-contracts.js";
import type { ProxyBroadcastResult } from "./proxy-broadcast.js";
import type { EncryptionProof, VerifiedDecryptedMessage } from "./proxy-receive.js";
import type { ProxySendResult } from "./proxy-send.js";
import type { EnvelopeHeaderDto } from "./wire-contracts.js";

const AgentIdSchema: z.ZodString = z.string().min(1).max(200);
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const SequenceSchema: z.ZodNumber = z.number().int().nonnegative().safe();
const ThreadIdSchema: z.ZodString = z.string().min(1).max(200);
const UuidSchema: z.ZodString = z.string().uuid();
const RootKeyIdSchema: z.ZodString = z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u);
const AgentKeyIdSchema: z.ZodString = z.string().regex(/^mak_[A-Za-z0-9_-]{43}$/u);

export type ProxyEncryptionProofDto = {
  readonly context_binding: "verified";
  readonly message_kind: "message" | "orchestration_request";
  readonly orchestrator_policy_id: string | null;
  readonly protocol: "murmur-e2ee-v1";
  readonly provenance: "sender_signed_server_asserted";
  readonly recipient_prekey_class: "fallback" | "one_time";
  readonly sender_agent_key_id: string;
  readonly sender_authority: "orchestrator" | "peer";
  readonly sender_root_key_id: string;
  readonly verification_mode: "organization" | "strict" | "tofu";
};

export type ProxyMessageDto = {
  readonly content: string;
  readonly context: MessageContextDto;
  readonly created_at: string;
  readonly encryption: ProxyEncryptionProofDto;
  readonly expires_at: string;
  readonly message_id: string;
  readonly read_at: string | null;
  readonly recipient_id: string;
  readonly sender_id: string;
  readonly sequence: number;
  readonly thread_id: string;
};

export type ProxySendMessageOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly message: ProxyMessageDto;
  readonly retention_days: number;
  readonly status: "stored";
};

export type ProxyAskOrchestratorOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly message: ProxyMessageDto;
  readonly orchestrator: EffectiveOrchestratorDto;
  readonly retention_days: number;
  readonly status: "stored";
};

export type ProxyInboxOutput = Record<string, unknown> & {
  readonly agent_id: string;
  readonly inbox_version: number;
  readonly messages: readonly ProxyMessageDto[];
};

export type ProxyWaitForMessagesOutput = Record<string, unknown> & {
  readonly agent_id: string;
  readonly messages: readonly ProxyMessageDto[];
  readonly timed_out: boolean;
};

export type ProxyBroadcastOutput = Record<string, unknown> & {
  readonly audience: {
    readonly machine?: string | undefined;
    readonly repository?: string | undefined;
  };
  readonly broadcast_id: string;
  readonly created_at: string;
  readonly duplicate: boolean;
  readonly encryption: {
    readonly protocol: "murmur-e2ee-v1";
    readonly recipients: readonly {
      readonly recipient_id: string;
      readonly verification_mode: "organization" | "strict" | "tofu";
    }[];
  };
  readonly expires_at: string;
  readonly recipient_count: number;
  readonly retention_days: number;
  readonly status: "stored";
  readonly thread_id: string;
};

const MessageContextSchema: z.ZodType<MessageContextDto> = z.strictObject({
  branch: z.string().min(1).max(500).optional(),
  client: AgentClientNameSchema.optional(),
  repository: z
    .string()
    .min(3)
    .max(500)
    .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u)
    .optional(),
});

export const ProxyEncryptionProofDtoSchema: z.ZodType<ProxyEncryptionProofDto> = z.strictObject({
  context_binding: z.literal("verified"),
  message_kind: z.enum(["message", "orchestration_request"]),
  orchestrator_policy_id: UuidSchema.nullable(),
  protocol: z.literal("murmur-e2ee-v1"),
  provenance: z.literal("sender_signed_server_asserted"),
  recipient_prekey_class: z.enum(["fallback", "one_time"]),
  sender_agent_key_id: AgentKeyIdSchema,
  sender_authority: z.enum(["orchestrator", "peer"]),
  sender_root_key_id: RootKeyIdSchema,
  verification_mode: z.enum(["organization", "strict", "tofu"]),
});

export const ProxyMessageDtoSchema: z.ZodType<ProxyMessageDto> = z.strictObject({
  content: z.string().min(1).max(100_000),
  context: MessageContextSchema,
  created_at: InstantSchema,
  encryption: ProxyEncryptionProofDtoSchema,
  expires_at: InstantSchema,
  message_id: UuidSchema,
  read_at: InstantSchema.nullable(),
  recipient_id: AgentIdSchema,
  sender_id: AgentIdSchema,
  sequence: SequenceSchema.positive(),
  thread_id: ThreadIdSchema,
});

export const ProxySendMessageOutputSchema: z.ZodType<ProxySendMessageOutput> = z.strictObject({
  duplicate: z.boolean(),
  message: ProxyMessageDtoSchema,
  retention_days: z.number().int().positive().safe(),
  status: z.literal("stored"),
});

export const ProxyAskOrchestratorOutputSchema: z.ZodType<ProxyAskOrchestratorOutput> =
  z.strictObject({
    duplicate: z.boolean(),
    message: ProxyMessageDtoSchema,
    orchestrator: EffectiveOrchestratorDtoSchema,
    retention_days: z.number().int().positive().safe(),
    status: z.literal("stored"),
  });

export const ProxyInboxOutputSchema: z.ZodType<ProxyInboxOutput> = z.strictObject({
  agent_id: AgentIdSchema,
  inbox_version: SequenceSchema,
  messages: z.array(ProxyMessageDtoSchema).max(500),
});

export const ProxyWaitForMessagesOutputSchema: z.ZodType<ProxyWaitForMessagesOutput> =
  z.strictObject({
    agent_id: AgentIdSchema,
    messages: z.array(ProxyMessageDtoSchema).max(500),
    timed_out: z.boolean(),
  });

export const ProxyBroadcastOutputSchema: z.ZodType<ProxyBroadcastOutput> = z.strictObject({
  audience: z.strictObject({
    machine: z.string().min(1).max(200).optional(),
    repository: z
      .string()
      .min(3)
      .max(500)
      .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u)
      .optional(),
  }),
  broadcast_id: UuidSchema,
  created_at: InstantSchema,
  duplicate: z.boolean(),
  encryption: z.strictObject({
    protocol: z.literal("murmur-e2ee-v1"),
    recipients: z
      .array(
        z.strictObject({
          recipient_id: AgentIdSchema,
          verification_mode: z.enum(["organization", "strict", "tofu"]),
        }),
      )
      .max(100),
  }),
  expires_at: InstantSchema,
  recipient_count: z.number().int().nonnegative().max(100),
  retention_days: z.number().int().positive().safe(),
  status: z.literal("stored"),
  thread_id: ThreadIdSchema,
});

function proofToDto(proof: EncryptionProof): ProxyEncryptionProofDto {
  return {
    context_binding: proof.contextBinding,
    message_kind: proof.messageKind,
    orchestrator_policy_id: proof.orchestratorPolicyId,
    protocol: proof.protocol,
    provenance: proof.provenance,
    recipient_prekey_class: proof.recipientPrekeyClass,
    sender_agent_key_id: proof.senderAgentKeyId,
    sender_authority: proof.senderAuthority,
    sender_root_key_id: proof.senderRootKeyId,
    verification_mode: proof.verificationMode,
  };
}

function contextFromHeader(header: EnvelopeHeaderDto): MessageContextDto {
  return {
    ...(header.branch_name === null ? {} : { branch: header.branch_name }),
    ...(header.client === null ? {} : { client: header.client }),
    ...(header.repository_name === null ? {} : { repository: header.repository_name }),
  };
}

function sentProof(result: ProxySendResult): ProxyEncryptionProofDto {
  const header: EnvelopeHeaderDto = result.output.message.envelope.header;
  return {
    context_binding: "verified",
    message_kind: header.message_kind,
    orchestrator_policy_id: header.orchestrator_policy_id,
    protocol: header.protocol,
    provenance: "sender_signed_server_asserted",
    recipient_prekey_class: header.recipient_prekey_class,
    sender_agent_key_id: header.sender_agent_key_id,
    sender_authority: header.sender_authority,
    sender_root_key_id: header.sender_root_key_id,
    verification_mode: result.verificationMode,
  };
}

export function sentMessageToProxyDto(result: ProxySendResult): ProxyMessageDto {
  const wire: ProxySendResult["output"]["message"] = result.output.message;
  const header: EnvelopeHeaderDto = wire.envelope.header;
  return ProxyMessageDtoSchema.parse({
    content: result.content,
    context: contextFromHeader(header),
    created_at: header.created_at,
    encryption: sentProof(result),
    expires_at: header.expires_at,
    message_id: header.message_id,
    read_at: wire.read_at,
    recipient_id: header.recipient_id,
    sender_id: header.sender_id,
    sequence: wire.tenant_sequence,
    thread_id: header.thread_id,
  });
}

export function decryptedMessageToProxyDto(message: VerifiedDecryptedMessage): ProxyMessageDto {
  const header: EnvelopeHeaderDto = message.wire.envelope.header;
  return ProxyMessageDtoSchema.parse({
    content: message.content,
    context: contextFromHeader(header),
    created_at: header.created_at,
    encryption: proofToDto(message.proof),
    expires_at: header.expires_at,
    message_id: header.message_id,
    read_at: message.wire.read_at,
    recipient_id: header.recipient_id,
    sender_id: header.sender_id,
    sequence: message.wire.tenant_sequence,
    thread_id: header.thread_id,
  });
}

export function broadcastToProxyOutput(
  result: ProxyBroadcastResult,
  audience: ProxyBroadcastOutput["audience"],
): ProxyBroadcastOutput {
  return ProxyBroadcastOutputSchema.parse({
    audience,
    broadcast_id: result.output.broadcast_id,
    created_at: result.output.committed_at,
    duplicate: result.output.duplicate,
    encryption: {
      protocol: "murmur-e2ee-v1",
      recipients: result.recipients.map(
        (
          recipient: ProxyBroadcastResult["recipients"][number],
        ): {
          readonly recipient_id: string;
          readonly verification_mode: "organization" | "strict" | "tofu";
        } => ({
          recipient_id: recipient.recipientId,
          verification_mode: recipient.verificationMode,
        }),
      ),
    },
    expires_at: result.prepared.expires_at,
    recipient_count: result.output.recipient_count,
    retention_days: 30,
    status: result.output.status,
    thread_id: result.prepared.thread_id,
  });
}
