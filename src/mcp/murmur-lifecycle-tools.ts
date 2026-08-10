import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  CloseAgentInputSchema,
  CloseAgentOutputSchema,
  closeAgentCommand,
  EndSessionInputSchema,
  EndSessionOutputSchema,
  endSessionCommand,
  toAgentDto,
} from "../domain/contracts.js";
import type {
  CloseAgentCommand,
  CloseAgentResult,
  EndSessionCommand,
  EndSessionResult,
} from "../domain/models.js";
import type { AgentId } from "../domain/value-objects.js";
import type { MessageStore } from "../storage/message-store.js";
import { toolResult } from "./murmur-tool-results.js";

const NAMES: ReadonlySet<string> = new Set(["end_session", "close_agent"]);

export async function callLifecycleTool(
  name: string,
  argumentsValue: unknown,
  store: MessageStore,
  notifyResourceListChanged: () => Promise<void>,
  authorizeAgentId: (input: string) => Promise<AgentId>,
): Promise<CallToolResult | null> {
  if (!NAMES.has(name)) return null;
  if (name === "end_session") {
    const input: ReturnType<typeof EndSessionInputSchema.parse> =
      EndSessionInputSchema.parse(argumentsValue);
    const parsed: EndSessionCommand = endSessionCommand(input);
    const result: EndSessionResult = await store.endSession({
      ...parsed,
      agentId: await authorizeAgentId(input.agent_id),
    });
    await notifyResourceListChanged();
    return toolResult(
      EndSessionOutputSchema.parse({
        ended: result.ended,
        generation: result.generation === null ? null : result.generation.value,
      }),
    );
  }
  const input: ReturnType<typeof CloseAgentInputSchema.parse> =
    CloseAgentInputSchema.parse(argumentsValue);
  const parsed: CloseAgentCommand = closeAgentCommand(input);
  const result: CloseAgentResult = await store.closeAgent({
    ...parsed,
    agentId: await authorizeAgentId(input.agent_id),
  });
  await notifyResourceListChanged();
  return toolResult(
    CloseAgentOutputSchema.parse({
      agent: toAgentDto(result.agent),
      already_closed: result.alreadyClosed,
      ended_sessions: result.endedSessions,
      unread_count: result.unreadCount,
    }),
  );
}
