import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  type BroadcastMessageInput,
  BroadcastMessageInputSchema,
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
import { toolResult } from "../mcp/murmur-tool-results.js";
import {
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
    case "send_message": {
      const input: SendMessageInput = SendMessageInputSchema.parse(argumentsValue);
      return toolResult(await operations.sendMessage(input));
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
