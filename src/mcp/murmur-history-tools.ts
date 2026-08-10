import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type GetMessageHistoryInput,
  GetMessageHistoryInputSchema,
  historyQuery,
  type MessageHistoryOutput,
  MessageHistoryOutputSchema,
  toHistoryMessageDto,
} from "../domain/history-contracts.js";
import type { GetMessagesQuery, Message } from "../domain/models.js";
import type { AgentGeneration } from "../domain/lifecycle-values.js";
import type { MessageStore } from "../storage/message-store.js";
import { toolResult } from "./murmur-tool-results.js";

export async function callHistoryTool(
  name: string,
  argumentsValue: unknown,
  store: MessageStore,
): Promise<CallToolResult | null> {
  if (name !== "get_message_history") return null;
  const input: GetMessageHistoryInput = GetMessageHistoryInputSchema.parse(argumentsValue);
  const query: GetMessagesQuery = historyQuery(input);
  const generation: AgentGeneration | null | undefined = query.generation;
  if (generation === null || generation === undefined) {
    throw new Error("History requires an explicit agent generation");
  }
  const messages: readonly Message[] = await store.getMessages(query);
  const output: MessageHistoryOutput = MessageHistoryOutputSchema.parse({
    agent_id: query.agentId.value,
    generation: generation.value,
    inbox_version: (await store.getInboxVersion(query.agentId, generation)).value,
    messages: messages.map(toHistoryMessageDto),
  });
  return toolResult(output);
}
