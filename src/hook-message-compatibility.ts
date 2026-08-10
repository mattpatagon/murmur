import {
  type InboxOutput,
  InboxOutputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
} from "./domain/contracts.js";
import type { HookOrchestrationState } from "./hook-orchestration.js";

export type InboxSummary = {
  readonly inboxVersion: number;
  readonly messageCount: number;
  readonly orchestration?: HookOrchestrationState | undefined;
  readonly orchestratorMessageCount?: number | undefined;
  readonly senderIds: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookMessageContext(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    branch: value["branch"],
    client: value["client"],
    repository: value["repository"],
  };
}

function hookMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    content: value["content"],
    context: hookMessageContext(value["context"]),
    created_at: value["created_at"],
    expires_at: value["expires_at"],
    message_id: value["message_id"],
    message_kind: value["message_kind"] ?? "message",
    orchestrator_policy_id: value["orchestrator_policy_id"] ?? null,
    read_at: value["read_at"],
    recipient_id: value["recipient_id"],
    sender_authority: value["sender_authority"] ?? "peer",
    sender_id: value["sender_id"],
    sequence: value["sequence"],
    thread_id: value["thread_id"],
  };
}

export function parseHookInbox(value: unknown): InboxOutput {
  if (!isRecord(value)) return InboxOutputSchema.parse(value);
  const rawMessages: unknown = value["messages"];
  return InboxOutputSchema.parse({
    agent_id: value["agent_id"],
    inbox_version: value["inbox_version"],
    messages: Array.isArray(rawMessages) ? rawMessages.map(hookMessage) : rawMessages,
  });
}

export function parseHookRegistration(value: unknown): RegisterAgentOutput {
  if (!isRecord(value)) return RegisterAgentOutputSchema.parse(value);
  const rawAgent: unknown = value["agent"];
  if (!isRecord(rawAgent)) return RegisterAgentOutputSchema.parse(value);
  return RegisterAgentOutputSchema.parse({
    ...value,
    agent: {
      ...rawAgent,
      authority: rawAgent["authority"] ?? "peer",
    },
  });
}

export function summarizeHookInbox(
  value: unknown,
  afterSequence: number,
  orchestration: HookOrchestrationState,
): InboxSummary {
  const inbox: InboxOutput = parseHookInbox(value);
  const lastMessage: InboxOutput["messages"][number] | undefined = inbox.messages.at(-1);
  return {
    inboxVersion: lastMessage === undefined ? afterSequence : lastMessage.sequence,
    messageCount: inbox.messages.length,
    orchestration,
    orchestratorMessageCount: inbox.messages.filter(
      (message: InboxOutput["messages"][number]): boolean =>
        message.sender_authority === "orchestrator",
    ).length,
    senderIds: [
      ...new Set(
        inbox.messages.map((message: InboxOutput["messages"][number]): string => message.sender_id),
      ),
    ].slice(0, 5),
  };
}
