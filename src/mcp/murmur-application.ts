import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
  SubscribeRequest,
  Tool,
  ToolAnnotations,
  UnsubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  ToolSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  GetMessagesInputSchema,
  InboxOutputSchema,
  ListAgentsInputSchema,
  ListAgentsOutputSchema,
  MarkMessagesReadInputSchema,
  MarkMessagesReadOutputSchema,
  RegisterAgentInputSchema,
  RegisterAgentOutputSchema,
  RETENTION_DAYS,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  WaitForMessagesInputSchema,
  WaitForMessagesOutputSchema,
  agentClientFromInput,
  branchNameFromInput,
  nullableIdempotencyKey,
  nullableThreadId,
  parseContent,
  parseMessageIds,
  parseSequence,
  repositoryNameFromInput,
  registerAgentCommand,
  toAgentDto,
  toMessageDto,
  type GetMessagesInput,
  type InboxOutput,
  type ListAgentsInput,
  type ListAgentsOutput,
  type MarkMessagesReadInput,
  type MarkMessagesReadOutput,
  type RegisterAgentInput,
  type RegisterAgentOutput,
  type SendMessageInput,
  type SendMessageOutput,
  type WaitForMessagesInput,
  type WaitForMessagesOutput,
} from "../domain/contracts.js";
import type {
  Agent,
  GetMessagesQuery,
  MarkMessagesReadResult,
  Message,
  RegisterAgentCommand,
  SendMessageCommand,
  SendMessageResult,
} from "../domain/models.js";
import {
  AgentId,
  type AgentClient,
  type BranchName,
  type RepositoryName,
  Sequence,
} from "../domain/value-objects.js";
import type {
  InboxSubscription,
  InboxUpdateHandler,
  MessageStore,
} from "../storage/message-store.js";

const SERVER_VERSION: string = "0.1.0";
const INBOX_PREFIX: string = "murmur://inbox/";

type ListedResource = ListResourcesResult["resources"][number];

type ActiveInboxSubscription = {
  readonly storeSubscription: InboxSubscription;
};

export type MurmurApplicationDependencies = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient | null;
  readonly closeStoreOnClose?: boolean;
  readonly repositoryName: RepositoryName | null;
  readonly store: MessageStore;
};

function inboxUri(agentId: AgentId): string {
  return `${INBOX_PREFIX}${encodeURIComponent(agentId.value)}`;
}

function agentIdFromInboxUri(uri: string): AgentId {
  if (!uri.startsWith(INBOX_PREFIX)) {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI '${uri}'`);
  }
  const encoded: string = uri.slice(INBOX_PREFIX.length);
  if (encoded === "" || encoded.includes("/")) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid inbox resource URI '${uri}'`);
  }
  try {
    return AgentId.parse(decodeURIComponent(encoded));
  } catch (error: unknown) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid inbox resource URI '${uri}'`, {
      cause: error,
    });
  }
}

function toolResult(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}

function toolError(error: unknown): CallToolResult {
  const message: string = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

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

function messagesQuery(input: GetMessagesInput): GetMessagesQuery {
  return {
    afterSequence: parseSequence(input.after_sequence),
    agentId: AgentId.parse(input.agent_id),
    limit: input.limit,
    threadId: nullableThreadId(input.thread_id),
    unreadOnly: input.unread_only,
  };
}

export class MurmurApplication {
  public readonly server: Server;
  private readonly closeStoreOnClose: boolean;
  private readonly branchName: BranchName | null;
  private readonly client: AgentClient | null;
  private readonly repositoryName: RepositoryName | null;
  private readonly store: MessageStore;
  private readonly subscriptions: Map<string, ActiveInboxSubscription>;
  private readonly tools: Tool[];
  private closed: boolean;

  public constructor(dependencies: MurmurApplicationDependencies) {
    this.branchName = dependencies.branchName;
    this.client = dependencies.client;
    this.closeStoreOnClose = dependencies.closeStoreOnClose !== false;
    this.repositoryName = dependencies.repositoryName;
    this.store = dependencies.store;
    this.subscriptions = new Map<string, ActiveInboxSubscription>();
    this.tools = this.createTools();
    this.closed = false;
    this.server = new Server(
      { name: "murmur", version: SERVER_VERSION },
      {
        capabilities: {
          resources: { listChanged: true, subscribe: true },
          tools: {},
        },
        instructions:
          "Murmur provides durable agent-to-agent inboxes. Call register_agent first, then send_message or get_messages. " +
          "Outgoing messages include context.repository, context.branch, context.client, and a created_at timestamp. " +
          "Repository, branch, and client are detected from the launching agent when possible; otherwise send_message must supply them in context. " +
          "For push signals, subscribe to murmur://inbox/{agent_id}; always read the durable inbox after a notification or reconnect. " +
          `Messages expire automatically after ${RETENTION_DAYS} days. MCP notifications do not themselves guarantee that a host starts a new model turn.`,
      },
    );
    this.registerRequestHandlers();
    this.server.onclose = (): void => {
      void this.closeResources();
    };
  }

  private createTools(): Tool[] {
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
        {
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: true,
          title: "List agents",
        },
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
        "get_messages",
        "Read agent inbox",
        "Read an agent's durable inbox. Reading does not mark messages as read.",
        GetMessagesInputSchema,
        InboxOutputSchema,
        {
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: true,
          title: "Read agent inbox",
        },
      ),
      toolDefinition(
        "wait_for_messages",
        "Wait for agent messages",
        "Compatibility fallback for hosts that do not surface resource subscriptions. Wait for inbox messages for up to 25 seconds.",
        WaitForMessagesInputSchema,
        WaitForMessagesOutputSchema,
        {
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: true,
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
    ];
  }

  private registerRequestHandlers(): void {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (): Promise<ListToolsResult> => ({ tools: this.tools }),
    );
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest): Promise<CallToolResult> => this.callTool(request),
    );
    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (): Promise<ListResourcesResult> => ({
        resources: (await this.store.listAgents()).map(
          (agent: Agent): ListedResource => ({
            description: `Durable inbox for ${agent.agentId.value}`,
            mimeType: "application/json",
            name: `${agent.displayName.value} inbox`,
            uri: inboxUri(agent.agentId),
          }),
        ),
      }),
    );
    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (): Promise<ListResourceTemplatesResult> => ({
        resourceTemplates: [
          {
            description:
              "A durable inbox that emits resource-updated notifications when subscribed.",
            mimeType: "application/json",
            name: "Agent inbox",
            uriTemplate: `${INBOX_PREFIX}{agent_id}`,
          },
        ],
      }),
    );
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: ReadResourceRequest): Promise<ReadResourceResult> =>
        await this.readResource(request),
    );
    this.server.setRequestHandler(
      SubscribeRequestSchema,
      async (request: SubscribeRequest): Promise<Record<string, never>> => {
        const uri: string = request.params.uri;
        const agentId: AgentId = agentIdFromInboxUri(uri);
        if ((await this.store.getAgent(agentId)) === null) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Unknown agent '${agentId.value}'. Register it first.`,
          );
        }
        const existing: ActiveInboxSubscription | undefined = this.subscriptions.get(uri);
        if (existing !== undefined) {
          await existing.storeSubscription.close();
          this.subscriptions.delete(uri);
        }
        let latestSequence: Sequence = await this.store.getInboxVersion(agentId);
        const handler: InboxUpdateHandler = async (sequence: Sequence): Promise<void> => {
          if (!sequence.isAfter(latestSequence) || this.closed) return;
          await this.server.sendResourceUpdated({ uri });
          latestSequence = sequence;
        };
        const storeSubscription: InboxSubscription = await this.store.watchInbox(
          agentId,
          latestSequence,
          handler,
        );
        this.subscriptions.set(uri, { storeSubscription });
        return {};
      },
    );
    this.server.setRequestHandler(
      UnsubscribeRequestSchema,
      async (request: UnsubscribeRequest): Promise<Record<string, never>> => {
        const subscription: ActiveInboxSubscription | undefined = this.subscriptions.get(
          request.params.uri,
        );
        if (subscription !== undefined) await subscription.storeSubscription.close();
        this.subscriptions.delete(request.params.uri);
        return {};
      },
    );
  }

  private async callTool(request: CallToolRequest): Promise<CallToolResult> {
    try {
      switch (request.params.name) {
        case "register_agent": {
          const input: RegisterAgentInput = RegisterAgentInputSchema.parse(
            request.params.arguments,
          );
          const command: RegisterAgentCommand = registerAgentCommand(input);
          const wasKnown: boolean = (await this.store.getAgent(command.agentId)) !== null;
          const agent: Agent = await this.store.registerAgent(command);
          if (!wasKnown) await this.server.sendResourceListChanged();
          const output: RegisterAgentOutput = RegisterAgentOutputSchema.parse({
            agent: toAgentDto(agent),
            inbox_uri: inboxUri(command.agentId),
            retention_days: RETENTION_DAYS,
          });
          return toolResult(output);
        }
        case "list_agents": {
          const input: ListAgentsInput = ListAgentsInputSchema.parse(request.params.arguments);
          const output: ListAgentsOutput = ListAgentsOutputSchema.parse({
            agents: (await this.store.listAgents()).map(toAgentDto),
          });
          if (Object.keys(input).length !== 0) throw new Error("list_agents takes no arguments");
          return toolResult(output);
        }
        case "send_message": {
          const input: SendMessageInput = SendMessageInputSchema.parse(request.params.arguments);
          const repositoryName: RepositoryName | null = repositoryNameFromInput(
            input.context,
            this.repositoryName,
          );
          if (repositoryName === null) {
            throw new Error(
              "Message repository context is required. Supply context.repository or configure MURMUR_REPOSITORY/X-Murmur-Repository.",
            );
          }
          const branchName: BranchName | null = branchNameFromInput(input.context, this.branchName);
          if (branchName === null) {
            throw new Error(
              "Message branch context is required. Supply context.branch or configure MURMUR_BRANCH/X-Murmur-Branch.",
            );
          }
          const client: AgentClient | null = agentClientFromInput(input.context, this.client);
          if (client === null) {
            throw new Error(
              "Message client context is required. Supply context.client or configure MURMUR_CLIENT/X-Murmur-Client.",
            );
          }
          const command: SendMessageCommand = {
            branchName,
            client,
            content: parseContent(input.content),
            idempotencyKey: nullableIdempotencyKey(input.idempotency_key),
            recipientId: AgentId.parse(input.recipient_id),
            repositoryName,
            senderId: AgentId.parse(input.sender_id),
            threadId: nullableThreadId(input.thread_id),
          };
          const result: SendMessageResult = await this.store.sendMessage(command);
          const output: SendMessageOutput = SendMessageOutputSchema.parse({
            duplicate: result.duplicate,
            message: toMessageDto(result.message),
            retention_days: RETENTION_DAYS,
            status: "stored",
          });
          return toolResult(output);
        }
        case "get_messages": {
          const input: GetMessagesInput = GetMessagesInputSchema.parse(request.params.arguments);
          const query: GetMessagesQuery = messagesQuery(input);
          const messages: readonly Message[] = await this.store.getMessages(query);
          const output: InboxOutput = InboxOutputSchema.parse({
            agent_id: query.agentId.value,
            inbox_version: (await this.store.getInboxVersion(query.agentId)).value,
            messages: messages.map(toMessageDto),
          });
          return toolResult(output);
        }
        case "wait_for_messages": {
          const input: WaitForMessagesInput = WaitForMessagesInputSchema.parse(
            request.params.arguments,
          );
          return await this.waitForMessages(input);
        }
        case "mark_messages_read": {
          const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(
            request.params.arguments,
          );
          const result: MarkMessagesReadResult = await this.store.markMessagesRead({
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
          return toolError(new Error(`Unknown tool '${request.params.name}'`));
      }
    } catch (error: unknown) {
      return toolError(error);
    }
  }

  private async waitForMessages(input: WaitForMessagesInput): Promise<CallToolResult> {
    const agentId: AgentId = AgentId.parse(input.agent_id);
    const afterSequence: Sequence = parseSequence(input.after_sequence);
    const query: GetMessagesQuery = {
      afterSequence,
      agentId,
      limit: 100,
      threadId: null,
      unreadOnly: false,
    };
    let messages: readonly Message[] = await this.store.getMessages(query);
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
      const subscription: InboxSubscription = await this.store.watchInbox(
        agentId,
        afterSequence,
        handler,
      );
      try {
        const updateOutcome: Promise<"updated"> = updatePromise.then((): "updated" => "updated");
        const timeoutOutcome: Promise<"timed_out"> = Bun.sleep(input.timeout_seconds * 1000).then(
          (): "timed_out" => "timed_out",
        );
        const outcome: "timed_out" | "updated" = await Promise.race([
          updateOutcome,
          timeoutOutcome,
        ]);
        timedOut = outcome === "timed_out";
        messages = await this.store.getMessages(query);
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

  private async readResource(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const uri: string = request.params.uri;
    const agentId: AgentId = agentIdFromInboxUri(uri);
    const query: GetMessagesQuery = {
      afterSequence: Sequence.zero(),
      agentId,
      limit: 500,
      threadId: null,
      unreadOnly: false,
    };
    const messages: readonly Message[] = await this.store.getMessages(query);
    const inboxVersion: Sequence = await this.store.getInboxVersion(agentId);
    const output: InboxOutput = InboxOutputSchema.parse({
      agent_id: agentId.value,
      inbox_version: inboxVersion.value,
      messages: messages.map(toMessageDto),
    });
    return {
      contents: [
        {
          mimeType: "application/json",
          text: JSON.stringify(output, null, 2),
          uri,
        },
      ],
    };
  }

  private async closeResources(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const subscriptions: readonly ActiveInboxSubscription[] = Array.from(
      this.subscriptions.values(),
    );
    this.subscriptions.clear();
    await Promise.all(
      subscriptions.map(
        async (subscription: ActiveInboxSubscription): Promise<void> =>
          await subscription.storeSubscription.close(),
      ),
    );
    if (this.closeStoreOnClose) await this.store.close();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.closeResources();
    await this.server.close();
  }
}
