import { z } from "zod";

import { type MessageDto, MessageDtoSchema } from "../domain/contracts.js";
import { OrchestrationScopeKindSchema, SenderAuthoritySchema } from "../domain/orchestration.js";
import { type IssuedTokenDto, IssuedTokenDtoSchema } from "./contracts.js";
import type {
  EffectiveOrchestrator,
  OrchestratorPolicy,
  OrchestratorScope,
} from "./control-plane-contracts.js";

const AgentIdSchema: z.ZodString = z.string().trim().min(1).max(200);
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const KeyIdSchema: z.ZodString = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/u);
const RepositorySchema: z.ZodString = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u);
const InstructionsSchema: z.ZodType<string> = z
  .string()
  .min(1)
  .superRefine((value: string, context: z.core.$RefinementCtx<string>): void => {
    if (Buffer.byteLength(value, "utf8") > 8192) {
      context.addIssue({ code: "custom", message: "Instructions exceed 8192 UTF-8 bytes" });
    }
  });

export type OrchestratorScopeInput = {
  readonly personal_id?: string | undefined;
  readonly repository?: string | undefined;
  readonly scope_kind: "organization" | "personal";
};

function validateScopeInput(
  value: OrchestratorScopeInput,
  context: z.core.$RefinementCtx<OrchestratorScopeInput>,
): void {
  if (value.scope_kind === "personal" && value.personal_id === undefined) {
    context.addIssue({
      code: "custom",
      message: "A personal scope requires personal_id",
      path: ["personal_id"],
    });
  }
  if (value.scope_kind === "organization" && value.personal_id !== undefined) {
    context.addIssue({
      code: "custom",
      message: "An organization scope cannot include personal_id",
      path: ["personal_id"],
    });
  }
}

export const OrchestratorScopeInputSchema: z.ZodType<OrchestratorScopeInput> = z
  .strictObject({
    personal_id: z.string().uuid().optional(),
    repository: RepositorySchema.optional(),
    scope_kind: OrchestrationScopeKindSchema,
  })
  .superRefine(validateScopeInput);

export type CreateOrchestratorTokenInput = {
  readonly agent_id: string;
  readonly expires_at?: string | undefined;
  readonly name: string;
  readonly personal_id?: string | undefined;
  readonly repository?: string | undefined;
};

export const CreateOrchestratorTokenInputSchema: z.ZodType<CreateOrchestratorTokenInput> =
  z.strictObject({
    agent_id: AgentIdSchema,
    expires_at: InstantSchema.optional(),
    name: z.string().trim().min(1).max(200),
    personal_id: z.string().uuid().optional(),
    repository: RepositorySchema.optional(),
  });

export type SetOrchestratorPolicyInput = OrchestratorScopeInput & {
  readonly instructions: string;
  readonly orchestrator_key_id: string;
};

export const SetOrchestratorPolicyInputSchema: z.ZodType<SetOrchestratorPolicyInput> = z
  .strictObject({
    instructions: InstructionsSchema,
    orchestrator_key_id: KeyIdSchema,
    personal_id: z.string().uuid().optional(),
    repository: RepositorySchema.optional(),
    scope_kind: OrchestrationScopeKindSchema,
  })
  .superRefine(validateScopeInput);

export type ClearOrchestratorPolicyInput = OrchestratorScopeInput;
export const ClearOrchestratorPolicyInputSchema: z.ZodType<ClearOrchestratorPolicyInput> =
  OrchestratorScopeInputSchema;

export type ListOrchestratorPoliciesInput = {
  readonly cursor?: string | undefined;
  readonly limit: number;
};
export const ListOrchestratorPoliciesInputSchema: z.ZodType<ListOrchestratorPoliciesInput> =
  z.strictObject({
    cursor: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(100),
  });

export type GetOrchestratorInput = Record<string, never>;
export const GetOrchestratorInputSchema: z.ZodType<GetOrchestratorInput> = z.strictObject({});

export type AskOrchestratorInput = {
  readonly content: string;
  readonly context?:
    | {
        readonly branch?: string | undefined;
        readonly client?: "claude" | "codex" | undefined;
        readonly repository?: string | undefined;
      }
    | undefined;
  readonly idempotency_key: string;
  readonly sender_id: string;
  readonly thread_id?: string | undefined;
};

export const AskOrchestratorInputSchema: z.ZodType<AskOrchestratorInput> = z.strictObject({
  content: z.string().min(1).max(100_000),
  context: z
    .strictObject({
      branch: z.string().trim().min(1).max(500).optional(),
      client: z.enum(["claude", "codex"]).optional(),
      repository: RepositorySchema.optional(),
    })
    .optional(),
  idempotency_key: z.string().trim().min(1).max(200),
  sender_id: AgentIdSchema,
  thread_id: z.string().trim().min(1).max(200).optional(),
});

export type GetDelegationInput = { readonly policy_id: string };
export const GetDelegationInputSchema: z.ZodType<GetDelegationInput> = z.strictObject({
  policy_id: z.string().uuid(),
});

export type ScopeDto = {
  readonly personal_id: string | null;
  readonly repository: string | null;
  readonly scope_kind: "organization" | "personal";
};

export type EffectiveOrchestratorDto = {
  readonly agent_id: string;
  readonly policy_id: string;
  readonly scope: ScopeDto;
};

export type OrchestratorPolicyDto = EffectiveOrchestratorDto & {
  readonly created_at: string;
  readonly created_by_token_id: string;
  readonly enabled: boolean;
  readonly instructions: string;
  readonly orchestrator_token_id: string;
  readonly updated_at: string;
  readonly updated_by_token_id: string;
};

const ScopeDtoSchema: z.ZodType<ScopeDto> = z.strictObject({
  personal_id: z.string().uuid().nullable(),
  repository: RepositorySchema.nullable(),
  scope_kind: OrchestrationScopeKindSchema,
});

export const EffectiveOrchestratorDtoSchema: z.ZodType<EffectiveOrchestratorDto> = z.strictObject({
  agent_id: AgentIdSchema,
  policy_id: z.string().uuid(),
  scope: ScopeDtoSchema,
});

export const OrchestratorPolicyDtoSchema: z.ZodType<OrchestratorPolicyDto> = z.strictObject({
  agent_id: AgentIdSchema,
  created_at: InstantSchema,
  created_by_token_id: z.string().uuid(),
  enabled: z.boolean(),
  instructions: InstructionsSchema,
  orchestrator_token_id: z.string().uuid(),
  policy_id: z.string().uuid(),
  scope: ScopeDtoSchema,
  updated_at: InstantSchema,
  updated_by_token_id: z.string().uuid(),
});

export type CreateOrchestratorTokenOutput = Record<string, unknown> & {
  readonly token: IssuedTokenDto;
};
export const CreateOrchestratorTokenOutputSchema: z.ZodType<CreateOrchestratorTokenOutput> =
  z.strictObject({ token: IssuedTokenDtoSchema });

export type SetOrchestratorPolicyOutput = Record<string, unknown> & {
  readonly policy: OrchestratorPolicyDto;
};
export const SetOrchestratorPolicyOutputSchema: z.ZodType<SetOrchestratorPolicyOutput> =
  z.strictObject({ policy: OrchestratorPolicyDtoSchema });

export type ClearOrchestratorPolicyOutput = Record<string, unknown> & {
  readonly cleared: boolean;
};
export const ClearOrchestratorPolicyOutputSchema: z.ZodType<ClearOrchestratorPolicyOutput> =
  z.strictObject({ cleared: z.boolean() });

export type ListOrchestratorPoliciesOutput = Record<string, unknown> & {
  readonly next_cursor: string | null;
  readonly policies: OrchestratorPolicyDto[];
};
export const ListOrchestratorPoliciesOutputSchema: z.ZodType<ListOrchestratorPoliciesOutput> =
  z.strictObject({
    next_cursor: z.string().uuid().nullable(),
    policies: z.array(OrchestratorPolicyDtoSchema),
  });

export type GetOrchestratorOutput = Record<string, unknown> & {
  readonly caller_authority: "orchestrator" | "peer";
  readonly orchestrator: EffectiveOrchestratorDto | null;
};
export const GetOrchestratorOutputSchema: z.ZodType<GetOrchestratorOutput> = z.strictObject({
  caller_authority: SenderAuthoritySchema,
  orchestrator: EffectiveOrchestratorDtoSchema.nullable(),
});

export type AskOrchestratorOutput = Record<string, unknown> & {
  readonly duplicate: boolean;
  readonly message: MessageDto;
  readonly orchestrator: EffectiveOrchestratorDto;
  readonly retention_days: number;
  readonly status: string;
};
export const AskOrchestratorOutputSchema: z.ZodType<AskOrchestratorOutput> = z.strictObject({
  duplicate: z.boolean(),
  message: MessageDtoSchema,
  orchestrator: EffectiveOrchestratorDtoSchema,
  retention_days: z.number().int().positive(),
  status: z.string(),
});

export type GetDelegationOutput = Record<string, unknown> & {
  readonly policy: OrchestratorPolicyDto;
};
export const GetDelegationOutputSchema: z.ZodType<GetDelegationOutput> = z.strictObject({
  policy: OrchestratorPolicyDtoSchema,
});

function toScopeDto(scope: OrchestratorScope): ScopeDto {
  return {
    personal_id: scope.personalId === null ? null : scope.personalId.value,
    repository: scope.repositoryName === null ? null : scope.repositoryName.value,
    scope_kind: scope.kind,
  };
}

export function toEffectiveOrchestratorDto(
  orchestrator: EffectiveOrchestrator,
): EffectiveOrchestratorDto {
  return {
    agent_id: orchestrator.orchestratorAgentId.value,
    policy_id: orchestrator.policyId.value,
    scope: toScopeDto(orchestrator.scope),
  };
}

export function toOrchestratorPolicyDto(policy: OrchestratorPolicy): OrchestratorPolicyDto {
  return {
    ...toEffectiveOrchestratorDto({
      orchestratorAgentId: policy.orchestratorAgentId,
      policyId: policy.policyId,
      scope: policy.scope,
    }),
    created_at: policy.createdAt.toISOString(),
    created_by_token_id: policy.createdByTokenId,
    enabled: policy.enabled,
    instructions: policy.instructions,
    orchestrator_token_id: policy.orchestratorTokenId,
    updated_at: policy.updatedAt.toISOString(),
    updated_by_token_id: policy.updatedByTokenId,
  };
}
