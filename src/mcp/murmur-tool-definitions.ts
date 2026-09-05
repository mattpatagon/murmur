import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BroadcastMessageInputSchema,
  BroadcastMessageOutputSchema,
  CloseAgentInputSchema,
  CloseAgentOutputSchema,
  EndSessionInputSchema,
  EndSessionOutputSchema,
  GetAgentInputSchema,
  GetAgentOutputSchema,
  GetMessagesInputSchema,
  InboxOutputSchema,
  ListAgentsInputSchema,
  ListAgentsOutputSchema,
  MarkMessagesReadInputSchema,
  MarkMessagesReadOutputSchema,
  RegisterAgentInputSchema,
  RegisterAgentOutputSchema,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  WaitForMessagesInputSchema,
  WaitForMessagesOutputSchema,
} from "../domain/contracts.js";
import {
  GetMessageHistoryInputSchema,
  MessageHistoryOutputSchema,
} from "../domain/history-contracts.js";
import {
  SubmitFeedbackInputSchema,
  SubmitFeedbackOutputSchema,
} from "../domain/feedback-contracts.js";
import { AGENT_LEASE_MINUTES } from "../domain/lifecycle-values.js";
import {
  ListNoticesInputSchema,
  ListNoticesOutputSchema,
  NoticeMutationOutputSchema,
  PostNoticeInputSchema,
  ResolveNoticeInputSchema,
  WithdrawNoticeInputSchema,
} from "../domain/notice-contracts.js";
import {
  BootstrapOperatorInputSchema,
  CreateOperatorTokenInputSchema,
  CreateTenantInputSchema,
  CreateTenantOutputSchema,
  IssuedOperatorTokenOutputSchema,
  IssuedTokenOutputSchema,
  ListAdminAuditInputSchema,
  ListAdminAuditOutputSchema,
  ListOperatorTokensInputSchema,
  ListOperatorTokensOutputSchema,
  ListTenantsInputSchema,
  ListTenantsOutputSchema,
  MintTenantAdminTokenInputSchema,
  RevokeTokenInputSchema,
  RevokeTokenOutputSchema,
  TenantIdInputSchema,
  TenantStatusOutputSchema,
} from "../hosted/contracts.js";
import type { HostedPrincipal } from "../hosted/control-plane.js";
import { entitledDataTools } from "./murmur-e2ee-tool-exposure.js";
import {
  bossOrchestrationTools,
  orchestratorLookupTool,
  tenantAdminOrchestrationTools,
  workerOrchestrationTools,
} from "./murmur-orchestration-tool-definitions.js";
import { tenantAdminTools } from "./murmur-tenant-admin-tool-definitions.js";
import type { E2eeEntitlementRecord, ToolExposure } from "./murmur-tool-exposure.js";
import { upgradeToolDefinition } from "./murmur-upgrade-tool.js";
import { toolDefinition } from "./tool-definition.js";
import { setupGuideToolDefinition } from "./murmur-setup-guide.js";

function dataTools(): Tool[] {
  return [
    toolDefinition(
      "register_agent",
      "Register agent",
      "Register or refresh an agent identity before sending or receiving messages.",
      RegisterAgentInputSchema,
      RegisterAgentOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Register agent",
      },
    ),
    toolDefinition(
      "list_agents",
      "List agents",
      "List registered agents that can participate in Murmur conversations.",
      ListAgentsInputSchema,
      ListAgentsOutputSchema,
      { destructiveHint: false, idempotentHint: true, readOnlyHint: true, title: "List agents" },
    ),
    toolDefinition(
      "get_agent",
      "Get agent",
      "Read one registered agent's current lifecycle state without renewing a session.",
      GetAgentInputSchema,
      GetAgentOutputSchema,
      { destructiveHint: false, idempotentHint: true, readOnlyHint: true, title: "Get agent" },
    ),
    toolDefinition(
      "send_message",
      "Send agent message",
      "Persist a message in another agent's inbox and trigger its subscribed MCP resource update. Repository, branch, and client context are filled from the call or launching agent; all three are required.",
      SendMessageInputSchema,
      SendMessageOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Send agent message",
      },
    ),
    toolDefinition(
      "broadcast_message",
      "Broadcast agent message",
      `Create one unread inbox delivery for every agent with a live ${AGENT_LEASE_MINUTES}-minute session lease that matches the optional audience filters. Repository and machine filters combine with AND; omit both to broadcast globally. The sender is excluded, agents outside the recipient snapshot cannot discover it later, and idempotent retries preserve the original snapshot. Use post_notice instead for shared repository state with a resolve-or-withdraw lifecycle.`,
      BroadcastMessageInputSchema,
      BroadcastMessageOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Broadcast agent message",
      },
    ),
    toolDefinition(
      "submit_feedback",
      "Submit Murmur feedback",
      "Persist an issue or feature request for Murmur maintainers. Set type to issue or feature_request. Submissions are intentionally maintainer-readable plaintext even when agent messages use E2E encryption; never include credentials, secrets, private message content, vulnerability details, or sensitive production data. Report suspected vulnerabilities privately at https://github.com/mattpatagon/murmur/security/advisories/new.",
      SubmitFeedbackInputSchema,
      SubmitFeedbackOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Submit Murmur feedback",
      },
    ),
    toolDefinition(
      "get_messages",
      "Read agent inbox",
      "Read an agent's durable inbox. Reading does not mark messages as read; supplying session_key renews that named lease.",
      GetMessagesInputSchema,
      InboxOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Read agent inbox",
      },
    ),
    toolDefinition(
      "wait_for_messages",
      "Wait for agent messages",
      "Compatibility fallback for hosts that do not surface resource subscriptions. Wait for inbox messages for up to 25 seconds; supplying session_key renews that named lease.",
      WaitForMessagesInputSchema,
      WaitForMessagesOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Wait for agent messages",
      },
    ),
    toolDefinition(
      "mark_messages_read",
      "Mark messages read",
      "Mark specific messages as read, only when they belong to the supplied recipient agent.",
      MarkMessagesReadInputSchema,
      MarkMessagesReadOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Mark messages read",
      },
    ),
    toolDefinition(
      "get_message_history",
      "Read generation history",
      "Read one explicit historical inbox generation without renewing an agent session.",
      GetMessageHistoryInputSchema,
      MessageHistoryOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Read generation history",
      },
    ),
    toolDefinition(
      "end_session",
      "End agent session",
      "End one session lease in an explicitly expected agent generation. Stop hooks also end the compatibility default lease atomically.",
      EndSessionInputSchema,
      EndSessionOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "End agent session",
      },
    ),
    toolDefinition(
      "close_agent",
      "Close agent",
      "Explicitly close an expected agent generation and all of its live sessions.",
      CloseAgentInputSchema,
      CloseAgentOutputSchema,
      { destructiveHint: true, idempotentHint: true, readOnlyHint: false, title: "Close agent" },
    ),
    toolDefinition(
      "post_notice",
      "Post coordination notice",
      "Create one shared repository-scoped handoff, ownership, blocker, or decision record with a bounded TTL. A notice creates no inbox deliveries: current and future agents discover it with list_notices, then explicitly resolve or withdraw it. Use broadcast_message instead for immediate per-recipient unread inbox delivery to the currently active audience.",
      PostNoticeInputSchema,
      NoticeMutationOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Post coordination notice",
      },
    ),
    toolDefinition(
      "list_notices",
      "List coordination notices",
      "List one cursor-paginated page of repository notices. Reading never creates a default lease; supplying session_key renews that named lease.",
      ListNoticesInputSchema,
      ListNoticesOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "List coordination notices",
      },
    ),
    toolDefinition(
      "resolve_notice",
      "Resolve coordination notice",
      "Resolve an open repository notice as any registered tenant actor.",
      ResolveNoticeInputSchema,
      NoticeMutationOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Resolve coordination notice",
      },
    ),
    toolDefinition(
      "withdraw_notice",
      "Withdraw coordination notice",
      "Withdraw an open repository notice using the same stable agent identity that created it.",
      WithdrawNoticeInputSchema,
      NoticeMutationOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Withdraw coordination notice",
      },
    ),
  ];
}
function bootstrapTools(): Tool[] {
  return [
    toolDefinition(
      "bootstrap_operator",
      "Bootstrap hosted operator",
      "One-time hosted bootstrap. Install the caller-generated first operator credential and permanently close the bootstrap gate. Retain the secret before calling so an ambiguous response cannot cause lockout.",
      BootstrapOperatorInputSchema,
      IssuedOperatorTokenOutputSchema,
      {
        destructiveHint: true,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Bootstrap hosted operator",
      },
    ),
  ];
}
function operatorTools(exposure: ToolExposure): Tool[] {
  const tools: Tool[] = [
    toolDefinition(
      "adopt_legacy_founding_token",
      "Adopt founding tenant token",
      "One-time transition: adopt the configured legacy bearer as a database-backed administrator token for the founding tenant before strict authentication is enabled.",
      z.strictObject({}),
      TenantStatusOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Adopt founding tenant token",
      },
    ),
    toolDefinition(
      "create_operator_token",
      "Create operator token",
      "Create a named hosted-operator credential for rotation or another authorized operator. The secret is returned exactly once.",
      CreateOperatorTokenInputSchema,
      IssuedOperatorTokenOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Create operator token",
      },
    ),
    toolDefinition(
      "list_operator_tokens",
      "List operator tokens",
      "List one cursor-paginated page of operator credential identifiers and lifecycle timestamps. Token secrets are never returned.",
      ListOperatorTokensInputSchema,
      ListOperatorTokensOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "List operator tokens",
      },
    ),
    toolDefinition(
      "revoke_operator_token",
      "Revoke operator token",
      "Revoke one operator credential and close its live sessions. The last active operator credential cannot be revoked.",
      RevokeTokenInputSchema,
      RevokeTokenOutputSchema,
      {
        destructiveHint: true,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Revoke operator token",
      },
    ),
    toolDefinition(
      "list_admin_audit",
      "List administration audit",
      "Read the append-only audit trail for hosted operator actions. Secrets and credential hashes are never recorded.",
      ListAdminAuditInputSchema,
      ListAdminAuditOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "List administration audit",
      },
    ),
    toolDefinition(
      "create_tenant",
      "Create tenant",
      "Create an isolated tenant and its first tenant-administrator token. The token secret is returned exactly once.",
      CreateTenantInputSchema,
      CreateTenantOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Create tenant",
      },
    ),
    toolDefinition(
      "list_tenants",
      "List tenants",
      "List one cursor-paginated page of hosted tenants and their active or suspended status.",
      ListTenantsInputSchema,
      ListTenantsOutputSchema,
      { destructiveHint: false, idempotentHint: true, readOnlyHint: true, title: "List tenants" },
    ),
    toolDefinition(
      "mint_tenant_admin_token",
      "Mint tenant administrator token",
      "Create a tenant-administrator token for one active tenant. The token secret is returned exactly once.",
      MintTenantAdminTokenInputSchema,
      IssuedTokenOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Mint tenant administrator token",
      },
    ),
    toolDefinition(
      "suspend_tenant",
      "Suspend tenant",
      "Suspend a tenant so all of its access tokens fail authentication immediately.",
      TenantIdInputSchema,
      TenantStatusOutputSchema,
      { destructiveHint: true, idempotentHint: true, readOnlyHint: false, title: "Suspend tenant" },
    ),
    toolDefinition(
      "restore_tenant",
      "Restore tenant",
      "Restore a suspended tenant so its unexpired, unrevoked tokens authenticate again.",
      TenantIdInputSchema,
      TenantStatusOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Restore tenant",
      },
    ),
  ];
  return tools.filter((tool: Tool): boolean => {
    if (!exposure.tenantOnboardingEnabled && tool.name === "create_tenant") return false;
    if (!exposure.legacyAdoptionEnabled && tool.name === "adopt_legacy_founding_token")
      return false;
    return true;
  });
}

function principalToolsForExposure(exposure: ToolExposure): Tool[] {
  const principal: HostedPrincipal | null = exposure.principal;
  if (principal !== null && principal.kind === "bootstrap") {
    return exposure.bootstrapEnabled ? bootstrapTools() : [];
  }
  if (principal !== null && principal.kind === "operator") return operatorTools(exposure);
  if (
    principal !== null &&
    principal.kind === "tenant" &&
    principal.role === "orchestrator" &&
    exposure.orchestrationEnabled !== true
  ) {
    return [];
  }
  const entitlement: E2eeEntitlementRecord | null = exposure.e2eeEntitlement ?? null;
  const tools: Tool[] =
    principal !== null && principal.kind === "tenant" && entitlement !== null
      ? entitledDataTools(
          entitlement,
          dataTools(),
          exposure.orchestrationEnabled === true && principal.role !== "orchestrator",
        )
      : dataTools();
  if (principal !== null && principal.kind === "tenant" && exposure.orchestrationEnabled === true) {
    if (principal.role === "orchestrator") {
      tools.push(...bossOrchestrationTools());
    } else if (entitlement !== null && entitlement.state === "enforced") {
      tools.push(orchestratorLookupTool());
    } else {
      tools.push(...workerOrchestrationTools());
    }
  }
  if (principal !== null && principal.kind === "tenant" && principal.role === "tenant_admin") {
    tools.push(...tenantAdminTools());
    if (exposure.orchestrationEnabled === true) tools.push(...tenantAdminOrchestrationTools());
  }
  return tools;
}

export function toolsForPrincipal(exposure: ToolExposure): Tool[] {
  const tools: Tool[] = principalToolsForExposure(exposure);
  tools.push(upgradeToolDefinition(), setupGuideToolDefinition());
  return tools;
}
