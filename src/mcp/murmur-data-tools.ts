import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  agentClientFromInput,
  type BroadcastMessageInput,
  BroadcastMessageInputSchema,
  type BroadcastMessageOutput,
  BroadcastMessageOutputSchema,
  branchNameFromInput,
  broadcastAudienceFromInput,
  type GetMessagesInput,
  GetMessagesInputSchema,
  type InboxOutput,
  InboxOutputSchema,
  type ListAgentsInput,
  ListAgentsInputSchema,
  type ListAgentsOutput,
  ListAgentsOutputSchema,
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  type MessageContextDto,
  nullableIdempotencyKey,
  nullableThreadId,
  parseContent,
  parseMessageIds,
  parseSequence,
  RETENTION_DAYS,
  type RegisterAgentInput,
  RegisterAgentInputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
  registerAgentCommand,
  repositoryNameFromInput,
  type SendMessageInput,
  SendMessageInputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
  toAgentDto,
  toMessageDto,
  type WaitForMessagesInput,
  WaitForMessagesInputSchema,
  type WaitForMessagesOutput,
  WaitForMessagesOutputSchema,
} from "../domain/contracts.js";
import type {
  Agent,
  BroadcastMessageCommand,
  BroadcastMessageResult,
  GetMessagesQuery,
  MarkMessagesReadResult,
  Message,
  RegisterAgentCommand,
  SendMessageCommand,
  SendMessageResult,
} from "../domain/models.js";
import {
  type AgentClient,
  AgentId,
  BoundedJsonObjectSchema,
  type BranchName,
  type JsonObject,
  MachineName,
  type RepositoryName,
  type Sequence,
} from "../domain/value-objects.js";
import type {
  InboxSubscription,
  InboxUpdateHandler,
  MessageStore,
} from "../storage/message-store.js";
import { toolResult } from "./murmur-tool-results.js";

const INBOX_PREFIX: string = "murmur://inbox/";

export type DataToolContext = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly notifyResourceListChanged: () => Promise<void>;
  readonly repositoryName: RepositoryName | null;
  readonly store: MessageStore | null;
};

const DATA_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "broadcast_message",
  "get_messages",
  "list_agents",
  "mark_messages_read",
  "register_agent",
  "send_message",
  "wait_for_messages",
]);

type RequiredMessageContext = {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly repositoryName: RepositoryName;
};

function inboxUri(agentId: AgentId): string {
  return `${INBOX_PREFIX}${encodeURIComponent(agentId.value)}`;
}

function messagesQuery(input: GetMessagesInput): GetMessagesQuery {
  return {
    afterSequence: parseSequence(input.after_sequence),
    agentId: AgentId.parse(input.agent_id),
    limit: input.limit,
    threadId: nullableThreadId(input.thread_id),
    unreadOnly: input.unread_only,
  };
}

function machineNameFromAgentId(agentId: AgentId): MachineName | null {
  const separatorIndex: number = agentId.value.indexOf(":");
  if (separatorIndex <= 0) return null;
  try {
    return MachineName.parse(agentId.value.slice(0, separatorIndex));
  } catch (_error: unknown) {
    return null;
  }
}

function requiredMessageContext(
  input: MessageContextDto | undefined,
  context: DataToolContext,
): RequiredMessageContext {
  const repositoryName: RepositoryName | null = repositoryNameFromInput(
    input,
    context.repositoryName,
  );
  if (repositoryName === null) {
    throw new Error(
      "Message repository context is required. Supply context.repository or configure MURMUR_REPOSITORY/X-Murmur-Repository.",
    );
  }
  const branchName: BranchName | null = branchNameFromInput(input, context.branchName);
  if (branchName === null) {
    throw new Error(
      "Message branch context is required. Supply context.branch or configure MURMUR_BRANCH/X-Murmur-Branch.",
    );
  }
  const client: AgentClient | null = agentClientFromInput(input, context.client);
  if (client === null) {
    throw new Error(
      "Message client context is required. Supply context.client or configure MURMUR_CLIENT/X-Murmur-Client.",
    );
  }
  return { branchName, client, repositoryName };
}

async function waitForMessages(
  store: MessageStore,
  input: WaitForMessagesInput,
): Promise<CallToolResult> {
  const agentId: AgentId = AgentId.parse(input.agent_id);
  const afterSequence: Sequence = parseSequence(input.after_sequence);
  const query: GetMessagesQuery = {
    afterSequence,
    agentId,
    limit: 100,
    threadId: null,
    unreadOnly: false,
  };
  let messages: readonly Message[] = await store.getMessages(query);
  let timedOut: boolean = false;
  if (messages.length === 0) {
    let resolveUpdate: (() => void) | null = null;
    const updatePromise: Promise<void> = new Promise((resolvePromise: () => void): void => {
      resolveUpdate = resolvePromise;
    });
    const handler: InboxUpdateHandler = async (): Promise<void> => {
      const resolver: (() => void) | null = resolveUpdate;
      if (resolver !== null) resolver();
    };
    const subscription: InboxSubscription = await store.watchInbox(agentId, afterSequence, handler);
    try {
      const updateOutcome: Promise<"updated"> = updatePromise.then((): "updated" => "updated");
      const timeoutOutcome: Promise<"timed_out"> = Bun.sleep(input.timeout_seconds * 1000).then(
        (): "timed_out" => "timed_out",
      );
      const outcome: "timed_out" | "updated" = await Promise.race([updateOutcome, timeoutOutcome]);
      timedOut = outcome === "timed_out";
      messages = await store.getMessages(query);
    } finally {
      await subscription.close();
    }
  }
  const output: WaitForMessagesOutput = WaitForMessagesOutputSchema.parse({
    agent_id: agentId.value,
    messages: messages.map(toMessageDto),
    timed_out: timedOut && messages.length === 0,
  });
  return toolResult(output);
}

export async function callDataTool(
  name: string,
  argumentsValue: unknown,
  context: DataToolContext,
): Promise<CallToolResult | null> {
  if (!DATA_TOOL_NAMES.has(name)) return null;
  const store: MessageStore | null = context.store;
  if (store === null) throw new Error("This credential cannot access tenant data");
  switch (name) {
    case "register_agent": {
      const input: RegisterAgentInput = RegisterAgentInputSchema.parse(argumentsValue);
      const parsed: RegisterAgentCommand = registerAgentCommand(input);
      const inferredMachine: MachineName | null = machineNameFromAgentId(parsed.agentId);
      const metadata: JsonObject = BoundedJsonObjectSchema.parse({
        ...(inferredMachine === null ? {} : { machine: inferredMachine.value }),
        ...parsed.metadata,
        ...(context.client === null ? {} : { client: context.client.value }),
        ...(context.repositoryName === null ? {} : { repository: context.repositoryName.value }),
      });
      const command: RegisterAgentCommand = { ...parsed, metadata };
      const wasKnown: boolean = (await store.getAgent(command.agentId)) !== null;
      const agent: Agent = await store.registerAgent(command);
      if (!wasKnown) await context.notifyResourceListChanged();
      const output: RegisterAgentOutput = RegisterAgentOutputSchema.parse({
        agent: toAgentDto(agent),
        inbox_uri: inboxUri(command.agentId),
        retention_days: RETENTION_DAYS,
      });
      return toolResult(output);
    }
    case "list_agents": {
      const input: ListAgentsInput = ListAgentsInputSchema.parse(argumentsValue);
      if (Object.keys(input).length !== 0) throw new Error("list_agents takes no arguments");
      const output: ListAgentsOutput = ListAgentsOutputSchema.parse({
        agents: (await store.listAgents()).map(toAgentDto),
      });
      return toolResult(output);
    }
    case "send_message": {
      const input: SendMessageInput = SendMessageInputSchema.parse(argumentsValue);
      const messageContext: RequiredMessageContext = requiredMessageContext(input.context, context);
      const command: SendMessageCommand = {
        ...messageContext,
        content: parseContent(input.content),
        idempotencyKey: nullableIdempotencyKey(input.idempotency_key),
        recipientId: AgentId.parse(input.recipient_id),
        senderId: AgentId.parse(input.sender_id),
        threadId: nullableThreadId(input.thread_id),
      };
      const result: SendMessageResult = await store.sendMessage(command);
      const output: SendMessageOutput = SendMessageOutputSchema.parse({
        duplicate: result.duplicate,
        message: toMessageDto(result.message),
        retention_days: RETENTION_DAYS,
        status: "stored",
      });
      return toolResult(output);
    }
    case "broadcast_message": {
      const input: BroadcastMessageInput = BroadcastMessageInputSchema.parse(argumentsValue);
      const messageContext: RequiredMessageContext = requiredMessageContext(input.context, context);
      const command: BroadcastMessageCommand = {
        audience: broadcastAudienceFromInput(input.audience),
        ...messageContext,
        content: parseContent(input.content),
        idempotencyKey: nullableIdempotencyKey(input.idempotency_key),
        senderId: AgentId.parse(input.sender_id),
        threadId: nullableThreadId(input.thread_id),
      };
      const result: BroadcastMessageResult = await store.broadcastMessage(command);
      const audience: BroadcastMessageOutput["audience"] = {
        ...(result.audience.machineName === null
          ? {}
          : { machine: result.audience.machineName.value }),
        ...(result.audience.repositoryName === null
          ? {}
          : { repository: result.audience.repositoryName.value }),
      };
      const output: BroadcastMessageOutput = BroadcastMessageOutputSchema.parse({
        audience,
        broadcast_id: result.broadcastId.value,
        created_at: result.createdAt.toISOString(),
        duplicate: result.duplicate,
        expires_at: result.expiresAt.toISOString(),
        recipient_count: result.recipientCount,
        retention_days: RETENTION_DAYS,
        status: "stored",
        thread_id: result.threadId.value,
      });
      return toolResult(output);
    }
    case "get_messages": {
      const input: GetMessagesInput = GetMessagesInputSchema.parse(argumentsValue);
      const query: GetMessagesQuery = messagesQuery(input);
      const messages: readonly Message[] = await store.getMessages(query);
      const output: InboxOutput = InboxOutputSchema.parse({
        agent_id: query.agentId.value,
        inbox_version: (await store.getInboxVersion(query.agentId)).value,
        messages: messages.map(toMessageDto),
      });
      return toolResult(output);
    }
    case "wait_for_messages": {
      const input: WaitForMessagesInput = WaitForMessagesInputSchema.parse(argumentsValue);
      return await waitForMessages(store, input);
    }
    case "mark_messages_read": {
      const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(argumentsValue);
      const result: MarkMessagesReadResult = await store.markMessagesRead({
        agentId: AgentId.parse(input.agent_id),
        messageIds: parseMessageIds(input.message_ids),
      });
      const output: MarkMessagesReadOutput = MarkMessagesReadOutputSchema.parse({
        read_at: result.readAt.toISOString(),
        updated: result.updated,
      });
      return toolResult(output);
    }
    default:
      return null;
  }
}
