import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  agentClientFromInput,
  branchNameFromInput,
  RETENTION_DAYS,
  repositoryNameFromInput,
  toMessageDto,
} from "../domain/contracts.js";
import { OrchestratorPolicyId, PersonalId } from "../domain/orchestration.js";
import {
  type AgentClient,
  AgentId,
  type BranchName,
  IdempotencyKey,
  Instant,
  MessageContent,
  RepositoryName,
  ThreadId,
} from "../domain/value-objects.js";
import { toIssuedTokenDto } from "../hosted/contracts.js";
import type {
  AskOrchestratorCommand,
  EffectiveOrchestrator,
  HostedControlPlane,
  IssuedToken,
  OrchestrationRequestResult,
  OrchestratorPolicy,
  OrchestratorScope,
  Page,
  TenantPrincipal,
} from "../hosted/control-plane.js";
import {
  type AskOrchestratorInput,
  AskOrchestratorInputSchema,
  type AskOrchestratorOutput,
  AskOrchestratorOutputSchema,
  type ClearOrchestratorPolicyInput,
  ClearOrchestratorPolicyInputSchema,
  type ClearOrchestratorPolicyOutput,
  ClearOrchestratorPolicyOutputSchema,
  type CreateOrchestratorTokenInput,
  CreateOrchestratorTokenInputSchema,
  type CreateOrchestratorTokenOutput,
  CreateOrchestratorTokenOutputSchema,
  type GetDelegationInput,
  GetDelegationInputSchema,
  type GetDelegationOutput,
  GetDelegationOutputSchema,
  type GetOrchestratorInput,
  GetOrchestratorInputSchema,
  type GetOrchestratorOutput,
  GetOrchestratorOutputSchema,
  type ListOrchestratorPoliciesInput,
  ListOrchestratorPoliciesInputSchema,
  type ListOrchestratorPoliciesOutput,
  ListOrchestratorPoliciesOutputSchema,
  type OrchestratorScopeInput,
  type SetOrchestratorPolicyInput,
  SetOrchestratorPolicyInputSchema,
  type SetOrchestratorPolicyOutput,
  SetOrchestratorPolicyOutputSchema,
  toEffectiveOrchestratorDto,
  toOrchestratorPolicyDto,
} from "../hosted/orchestration-contracts.js";
import { toolResult } from "./murmur-tool-results.js";

export type OrchestrationToolContext = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly controlPlane: HostedControlPlane;
  readonly principal: TenantPrincipal;
  readonly repositoryName: RepositoryName | null;
};

const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "ask_orchestrator",
  "clear_orchestrator_policy",
  "create_orchestrator_token",
  "get_delegation",
  "get_orchestrator",
  "list_orchestrator_policies",
  "set_orchestrator_policy",
]);

function scopeFromInput(input: OrchestratorScopeInput): OrchestratorScope {
  return {
    kind: input.scope_kind,
    personalId: input.scope_kind === "personal" ? PersonalId.parse(input.personal_id) : null,
    repositoryName: input.repository === undefined ? null : RepositoryName.parse(input.repository),
  };
}

function requiredContext(
  input: AskOrchestratorInput["context"],
  context: OrchestrationToolContext,
): {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly repositoryName: RepositoryName;
} {
  const repositoryName: RepositoryName | null = repositoryNameFromInput(
    input,
    context.repositoryName,
  );
  const branchName: BranchName | null = branchNameFromInput(input, context.branchName);
  const client: AgentClient | null = agentClientFromInput(input, context.client);
  if (repositoryName === null || branchName === null || client === null) {
    throw new Error("Orchestration requests require repository, branch, and client context");
  }
  return { branchName, client, repositoryName };
}

export async function callOrchestrationTool(
  name: string,
  argumentsValue: unknown,
  context: OrchestrationToolContext,
): Promise<CallToolResult | null> {
  if (!ORCHESTRATION_TOOL_NAMES.has(name)) return null;
  const principal: TenantPrincipal = context.principal;
  const controlPlane: HostedControlPlane = context.controlPlane;
  switch (name) {
    case "create_orchestrator_token": {
      if (principal.role !== "tenant_admin") return null;
      const input: CreateOrchestratorTokenInput =
        CreateOrchestratorTokenInputSchema.parse(argumentsValue);
      const token: IssuedToken = await controlPlane.createOrchestratorToken(
        principal,
        AgentId.parse(input.agent_id),
        input.name,
        input.expires_at === undefined ? null : Instant.parse(input.expires_at),
        input.personal_id === undefined ? null : PersonalId.parse(input.personal_id),
        input.repository === undefined ? null : RepositoryName.parse(input.repository),
      );
      const output: CreateOrchestratorTokenOutput = CreateOrchestratorTokenOutputSchema.parse({
        token: toIssuedTokenDto(token),
      });
      return toolResult(output);
    }
    case "set_orchestrator_policy": {
      if (principal.role !== "tenant_admin") return null;
      const input: SetOrchestratorPolicyInput =
        SetOrchestratorPolicyInputSchema.parse(argumentsValue);
      const policy: OrchestratorPolicy = await controlPlane.setOrchestratorPolicy(
        principal,
        scopeFromInput(input),
        input.orchestrator_key_id,
        input.instructions,
      );
      const output: SetOrchestratorPolicyOutput = SetOrchestratorPolicyOutputSchema.parse({
        policy: toOrchestratorPolicyDto(policy),
      });
      return toolResult(output);
    }
    case "clear_orchestrator_policy": {
      if (principal.role !== "tenant_admin") return null;
      const input: ClearOrchestratorPolicyInput =
        ClearOrchestratorPolicyInputSchema.parse(argumentsValue);
      const output: ClearOrchestratorPolicyOutput = ClearOrchestratorPolicyOutputSchema.parse({
        cleared: await controlPlane.clearOrchestratorPolicy(principal, scopeFromInput(input)),
      });
      return toolResult(output);
    }
    case "list_orchestrator_policies": {
      if (principal.role !== "tenant_admin") return null;
      const input: ListOrchestratorPoliciesInput =
        ListOrchestratorPoliciesInputSchema.parse(argumentsValue);
      const policyPage: Page<OrchestratorPolicy> = await controlPlane.listOrchestratorPolicies(
        principal,
        input.cursor ?? null,
        input.limit,
      );
      const output: ListOrchestratorPoliciesOutput = ListOrchestratorPoliciesOutputSchema.parse({
        next_cursor: policyPage.nextCursor,
        policies: policyPage.items.map(toOrchestratorPolicyDto),
      });
      return toolResult(output);
    }
    case "get_orchestrator": {
      const input: GetOrchestratorInput = GetOrchestratorInputSchema.parse(argumentsValue);
      if (Object.keys(input).length !== 0) throw new Error("get_orchestrator takes no arguments");
      const orchestrator: EffectiveOrchestrator | null =
        principal.role === "orchestrator"
          ? null
          : await controlPlane.resolveOrchestrator(principal);
      const output: GetOrchestratorOutput = GetOrchestratorOutputSchema.parse({
        caller_authority: principal.role === "orchestrator" ? "orchestrator" : "peer",
        orchestrator: orchestrator === null ? null : toEffectiveOrchestratorDto(orchestrator),
      });
      return toolResult(output);
    }
    case "ask_orchestrator": {
      if (principal.role === "orchestrator") return null;
      const input: AskOrchestratorInput = AskOrchestratorInputSchema.parse(argumentsValue);
      const messageContext: ReturnType<typeof requiredContext> = requiredContext(
        input.context,
        context,
      );
      const command: AskOrchestratorCommand = {
        ...messageContext,
        content: MessageContent.parse(input.content),
        idempotencyKey: IdempotencyKey.parse(input.idempotency_key),
        senderId: AgentId.parse(input.sender_id),
        threadId: input.thread_id === undefined ? null : ThreadId.parse(input.thread_id),
      };
      const result: OrchestrationRequestResult = await controlPlane.askOrchestrator(
        principal,
        command,
      );
      const output: AskOrchestratorOutput = AskOrchestratorOutputSchema.parse({
        duplicate: result.duplicate,
        message: toMessageDto(result.message),
        orchestrator: toEffectiveOrchestratorDto(result.policy),
        retention_days: RETENTION_DAYS,
        status: "stored",
      });
      return toolResult(output);
    }
    case "get_delegation": {
      if (principal.role !== "orchestrator") return null;
      const input: GetDelegationInput = GetDelegationInputSchema.parse(argumentsValue);
      const policy: OrchestratorPolicy | null = await controlPlane.getDelegation(
        principal,
        OrchestratorPolicyId.parse(input.policy_id),
      );
      if (policy === null) throw new Error("The delegation is unavailable for this credential");
      const output: GetDelegationOutput = GetDelegationOutputSchema.parse({
        policy: toOrchestratorPolicyDto(policy),
      });
      return toolResult(output);
    }
    default:
      return null;
  }
}
