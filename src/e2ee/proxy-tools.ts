import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  type BroadcastMessageInput,
  BroadcastMessageInputSchema,
  type CloseAgentInput,
  CloseAgentInputSchema,
  CloseAgentOutputSchema,
  type EndSessionInput,
  EndSessionInputSchema,
  EndSessionOutputSchema,
  type GetAgentInput,
  GetAgentInputSchema,
  GetAgentOutputSchema,
  type GetMessagesInput,
  GetMessagesInputSchema,
  type ListAgentsInput,
  ListAgentsInputSchema,
  ListAgentsOutputSchema,
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  MarkMessagesReadOutputSchema,
  type RegisterAgentInput,
  RegisterAgentInputSchema,
  RegisterAgentOutputSchema,
  type SendMessageInput,
  SendMessageInputSchema,
  type WaitForMessagesInput,
  WaitForMessagesInputSchema,
} from "../domain/contracts.js";
import {
  type SubmitFeedbackInput,
  SubmitFeedbackInputSchema,
  SubmitFeedbackOutputSchema,
} from "../domain/feedback-contracts.js";
import {
  type AskOrchestratorInput,
  AskOrchestratorInputSchema,
  type GetDelegationInput,
  GetDelegationInputSchema,
  GetDelegationOutputSchema,
  type GetOrchestratorInput,
  GetOrchestratorInputSchema,
  GetOrchestratorOutputSchema,
} from "../hosted/orchestration-contracts.js";
import { toolResult } from "../mcp/murmur-tool-results.js";
import {
  ProxyAskOrchestratorOutputSchema,
  ProxyBroadcastOutputSchema,
  ProxyInboxOutputSchema,
  ProxySendMessageOutputSchema,
  ProxyWaitForMessagesOutputSchema,
} from "./proxy-contracts.js";
import type { E2eeProxyOperations } from "./proxy-service.js";

function toolDefinition<Input, Output>(
  name: string,
  title: string,
  description: string,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  annotations: ToolAnnotations,
): Tool {
  const generatedInput: unknown = z.toJSONSchema(inputSchema);
  const generatedOutput: unknown = z.toJSONSchema(outputSchema);
  const validatedInput: Tool["inputSchema"] = ToolSchema.shape.inputSchema.parse(generatedInput);
  const validatedOutput: NonNullable<Tool["outputSchema"]> = ToolSchema.shape.outputSchema
    .unwrap()
    .parse(generatedOutput);
  return {
    annotations,
    description,
    inputSchema: validatedInput,
    name,
    outputSchema: validatedOutput,
    title,
  };
}

export function e2eeProxyTools(): readonly Tool[] {
  return [
    toolDefinition(
      "register_agent",
      "Register encrypted agent",
      "Register or refresh an agent and publish its local end-to-end encryption key bundle.",
      RegisterAgentInputSchema,
      RegisterAgentOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Register encrypted agent",
      },
    ),
    toolDefinition(
      "get_agent",
      "Read encrypted agent metadata",
      "Read one registered agent generation. This metadata-only operation never exposes message content.",
      GetAgentInputSchema,
      GetAgentOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Read encrypted agent metadata",
      },
    ),
    toolDefinition(
      "list_agents",
      "List encrypted agents",
      "List registered agents. This metadata-only operation never exposes message content.",
      ListAgentsInputSchema,
      ListAgentsOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "List encrypted agents",
      },
    ),
    toolDefinition(
      "end_session",
      "End encrypted agent session",
      "End one hosted session lease while retaining ciphertext and local private keys.",
      EndSessionInputSchema,
      EndSessionOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "End encrypted agent session",
      },
    ),
    toolDefinition(
      "close_agent",
      "Close encrypted agent",
      "Explicitly close one hosted agent generation and all of its live session leases.",
      CloseAgentInputSchema,
      CloseAgentOutputSchema,
      {
        destructiveHint: true,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Close encrypted agent",
      },
    ),
    toolDefinition(
      "submit_feedback",
      "Submit Murmur feedback",
      "Persist an issue or feature request as maintainer-readable plaintext, even while messages use E2E encryption. Never include credentials, secrets, private message content, vulnerability details, or sensitive production data. Report suspected vulnerabilities privately at https://github.com/mattpatagon/murmur/security/advisories/new.",
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
      "send_message",
      "Send encrypted agent message",
      "Encrypt locally, persist ciphertext in Murmur, and return the familiar message fields with verification evidence.",
      SendMessageInputSchema,
      ProxySendMessageOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Send encrypted agent message",
      },
    ),
    toolDefinition(
      "get_orchestrator",
      "Get encrypted orchestrator",
      "Resolve the authenticated scope's effective orchestrator without returning private delegation instructions.",
      GetOrchestratorInputSchema,
      GetOrchestratorOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Get encrypted orchestrator",
      },
    ),
    toolDefinition(
      "ask_orchestrator",
      "Ask encrypted orchestrator",
      "Encrypt the question locally and route only signed ciphertext to the server-selected orchestrator.",
      AskOrchestratorInputSchema,
      ProxyAskOrchestratorOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Ask encrypted orchestrator",
      },
    ),
    toolDefinition(
      "get_delegation",
      "Get encrypted delegation",
      "Read private delegation instructions only when the upstream credential is the bound orchestrator.",
      GetDelegationInputSchema,
      GetDelegationOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Get encrypted delegation",
      },
    ),
    toolDefinition(
      "broadcast_message",
      "Broadcast encrypted agent message",
      "Encrypt one distinct delivery per selected recipient and commit the audience atomically.",
      BroadcastMessageInputSchema,
      ProxyBroadcastOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Broadcast encrypted agent message",
      },
    ),
    toolDefinition(
      "get_messages",
      "Read encrypted agent inbox",
      "Read ciphertext from Murmur, verify and decrypt locally, and return plaintext only to this endpoint.",
      GetMessagesInputSchema,
      ProxyInboxOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Read encrypted agent inbox",
      },
    ),
    toolDefinition(
      "wait_for_messages",
      "Wait for encrypted agent messages",
      "Wait for ciphertext messages, then verify and decrypt them locally.",
      WaitForMessagesInputSchema,
      ProxyWaitForMessagesOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Wait for encrypted agent messages",
      },
    ),
    toolDefinition(
      "mark_messages_read",
      "Mark encrypted messages read",
      "Mark messages read remotely and purge their decrypted local cache entries.",
      MarkMessagesReadInputSchema,
      MarkMessagesReadOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Mark encrypted messages read",
      },
    ),
  ];
}

export async function callE2eeProxyTool(
  name: string,
  argumentsValue: unknown,
  operations: E2eeProxyOperations,
): Promise<CallToolResult | null> {
  switch (name) {
    case "register_agent": {
      const input: RegisterAgentInput = RegisterAgentInputSchema.parse(argumentsValue);
      return toolResult(await operations.registerAgent(input));
    }
    case "list_agents": {
      const input: ListAgentsInput = ListAgentsInputSchema.parse(argumentsValue);
      return toolResult(await operations.listAgents(input));
    }
    case "get_agent": {
      const input: GetAgentInput = GetAgentInputSchema.parse(argumentsValue);
      return toolResult(await operations.getAgent(input));
    }
    case "end_session": {
      const input: EndSessionInput = EndSessionInputSchema.parse(argumentsValue);
      return toolResult(await operations.endSession(input));
    }
    case "close_agent": {
      const input: CloseAgentInput = CloseAgentInputSchema.parse(argumentsValue);
      return toolResult(await operations.closeAgent(input));
    }
    case "submit_feedback": {
      const input: SubmitFeedbackInput = SubmitFeedbackInputSchema.parse(argumentsValue);
      return toolResult(await operations.submitFeedback(input));
    }
    case "send_message": {
      const input: SendMessageInput = SendMessageInputSchema.parse(argumentsValue);
      return toolResult(await operations.sendMessage(input));
    }
    case "get_orchestrator": {
      const input: GetOrchestratorInput = GetOrchestratorInputSchema.parse(argumentsValue);
      const operation: E2eeProxyOperations["getOrchestrator"] = operations.getOrchestrator;
      if (operation === undefined) throw new Error("Encrypted orchestration is unavailable");
      return toolResult(await operation.call(operations, input));
    }
    case "ask_orchestrator": {
      const input: AskOrchestratorInput = AskOrchestratorInputSchema.parse(argumentsValue);
      const operation: E2eeProxyOperations["askOrchestrator"] = operations.askOrchestrator;
      if (operation === undefined) throw new Error("Encrypted orchestration is unavailable");
      return toolResult(await operation.call(operations, input));
    }
    case "get_delegation": {
      const input: GetDelegationInput = GetDelegationInputSchema.parse(argumentsValue);
      const operation: E2eeProxyOperations["getDelegation"] = operations.getDelegation;
      if (operation === undefined) throw new Error("Encrypted orchestration is unavailable");
      return toolResult(await operation.call(operations, input));
    }
    case "broadcast_message": {
      const input: BroadcastMessageInput = BroadcastMessageInputSchema.parse(argumentsValue);
      return toolResult(await operations.broadcastMessage(input));
    }
    case "get_messages": {
      const input: GetMessagesInput = GetMessagesInputSchema.parse(argumentsValue);
      return toolResult(await operations.getMessages(input));
    }
    case "wait_for_messages": {
      const input: WaitForMessagesInput = WaitForMessagesInputSchema.parse(argumentsValue);
      return toolResult(await operations.waitForMessages(input));
    }
    case "mark_messages_read": {
      const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(argumentsValue);
      return toolResult(await operations.markMessagesRead(input));
    }
    default:
      return null;
  }
}
