import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  FeedbackId,
  type SubmitFeedbackCommand,
  type SubmitFeedbackResult,
} from "../../src/domain/feedback-models.js";
import { AgentGeneration } from "../../src/domain/lifecycle-values.js";
import { PersonalId } from "../../src/domain/orchestration.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  Instant,
  RepositoryName,
  TenantId,
} from "../../src/domain/value-objects.js";
import type {
  HostedControlPlane,
  Page,
  TenantPrincipal,
  TokenSummary,
} from "../../src/hosted/control-plane-contracts.js";
import { callTenantAdminTool } from "../../src/mcp/murmur-admin-tools.js";
import { callFeedbackTool } from "../../src/mcp/murmur-feedback-tools.js";
import type { MessageStore } from "../../src/storage/message-store.js";

export const FIXTURE_ID: string = "00000000-0000-4000-8000-000000000001";
export const FIXTURE_INSTANT: Instant = Instant.parse("2026-09-05T00:00:00.000Z");
export const FEEDBACK_INPUT: Readonly<Record<string, unknown>> = {
  description: "Feedback description",
  idempotency_key: "same-submission",
  reporter_id: "reporter",
  title: "Feedback title",
  type: "issue",
};

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

export function tokenSummary(name: string = "example"): TokenSummary {
  return {
    agentId: null,
    createdAt: FIXTURE_INSTANT,
    expiresAt: null,
    keyId: "abcdefgh",
    lastUsedAt: null,
    name,
    personalId: PersonalId.parse(FIXTURE_ID),
    repositoryName: null,
    revokedAt: null,
    role: "agent",
    tokenId: FIXTURE_ID,
  };
}

export function feedbackResult(
  command: SubmitFeedbackCommand,
  duplicate: boolean = false,
): SubmitFeedbackResult {
  return {
    duplicate,
    submission: {
      ...command,
      createdAt: FIXTURE_INSTANT,
      feedbackId: FeedbackId.parse(FIXTURE_ID),
      reporterGeneration: AgentGeneration.parse(1),
    },
  };
}

type TokenRequest = {
  readonly principal: TenantPrincipal;
  readonly cursor: string | null;
  readonly limit: number;
};

export class TenantToolFixture {
  public readonly tokenRequests: TokenRequest[] = [];
  public readonly feedbackRequests: SubmitFeedbackCommand[] = [];
  public readonly authorizationRequests: string[] = [];
  public readonly principal: TenantPrincipal = {
    kind: "tenant",
    role: "tenant_admin",
    tenantId: TenantId.parse(FIXTURE_ID),
    tokenId: FIXTURE_ID,
  };
  public tokenAction: () => Promise<Page<TokenSummary>> = async (): Promise<
    Page<TokenSummary>
  > => ({ items: [tokenSummary()], nextCursor: null });
  public feedbackAction: (command: SubmitFeedbackCommand) => Promise<SubmitFeedbackResult> = async (
    command: SubmitFeedbackCommand,
  ): Promise<SubmitFeedbackResult> => feedbackResult(command);
  public authorizationAction: () => Promise<void> = async (): Promise<void> => {};

  private controlPlane(): HostedControlPlane {
    return {
      adoptLegacyFoundingToken: unexpected,
      askOrchestrator: unexpected,
      authenticate: unexpected,
      bootstrapOperatorToken: unexpected,
      clearOrchestratorPolicy: unexpected,
      close: unexpected,
      createOperatorToken: unexpected,
      createOrchestratorToken: unexpected,
      createTenant: unexpected,
      createToken: unexpected,
      credentialAdmission: unexpected,
      getDelegation: unexpected,
      getE2eeEntitlement: unexpected,
      hasActiveOperator: unexpected,
      listAdminAudit: unexpected,
      listOperatorTokens: unexpected,
      listOrchestratorPolicies: unexpected,
      listTenants: unexpected,
      listTokens: async (
        principal: TenantPrincipal,
        cursor: string | null,
        limit: number,
      ): Promise<Page<TokenSummary>> => {
        this.tokenRequests.push({ principal, cursor, limit });
        return await this.tokenAction();
      },
      mintTenantAdminToken: unexpected,
      resetE2eeIdentity: unexpected,
      resolveOrchestrator: unexpected,
      restoreTenant: unexpected,
      revokeOperatorToken: unexpected,
      revokeToken: unexpected,
      selfServiceRegisterTenant: unexpected,
      setOrchestratorPolicy: unexpected,
      suspendTenant: unexpected,
      tenantOnboardingEnabled: unexpected,
      transitionE2ee: unexpected,
    };
  }

  private store(): MessageStore {
    return {
      broadcastMessage: unexpected,
      close: unexpected,
      closeAgent: unexpected,
      endSession: unexpected,
      getAgent: unexpected,
      getInboxVersion: unexpected,
      getMessages: unexpected,
      getMessagesWithVersion: unexpected,
      listAgents: unexpected,
      listNotices: unexpected,
      markMessagesRead: unexpected,
      postNotice: unexpected,
      pruneExpired: unexpected,
      registerAgent: unexpected,
      resolveNotice: unexpected,
      scope: unexpected,
      sendMessage: unexpected,
      submitFeedback: async (command: SubmitFeedbackCommand): Promise<SubmitFeedbackResult> => {
        this.feedbackRequests.push(command);
        return await this.feedbackAction(command);
      },
      watchInbox: unexpected,
      withdrawNotice: unexpected,
    };
  }

  public async listTokens(input: unknown = { limit: 1 }): Promise<CallToolResult | null> {
    return await callTenantAdminTool("list_access_tokens", input, this.principal, {
      controlPlane: this.controlPlane(),
      legacyCredentialHash: null,
      onE2eeStateChanged: null,
      onTenantSuspended: null,
      onTokenRevoked: null,
      tenantOnboardingEnabled: false,
    });
  }

  public async submitFeedback(input: unknown = FEEDBACK_INPUT): Promise<CallToolResult | null> {
    return await callFeedbackTool(
      "submit_feedback",
      input,
      this.store(),
      {
        branchName: BranchName.parse("main"),
        client: AgentClient.parse("codex"),
        repositoryName: RepositoryName.parse("owner/repository"),
      },
      async (input: string): Promise<AgentId> => {
        this.authorizationRequests.push(input);
        await this.authorizationAction();
        return AgentId.parse(input);
      },
    );
  }
}
