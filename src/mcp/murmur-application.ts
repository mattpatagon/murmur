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
import packageMetadata from "../../package.json" with { type: "json" };

import {
  BroadcastMessageInputSchema,
  BroadcastMessageOutputSchema,
  GetMessagesInputSchema,
  InboxOutputSchema,
  ListAgentsInputSchema,
  ListAgentsOutputSchema,
  MarkMessagesReadInputSchema,
  MarkMessagesReadOutputSchema,
  RegisterAgentInputSchema,
  RegisterAgentOutputSchema,
  ACTIVE_AGENT_WINDOW_MINUTES,
  RETENTION_DAYS,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  WaitForMessagesInputSchema,
  WaitForMessagesOutputSchema,
  agentClientFromInput,
  broadcastAudienceFromInput,
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
  type BroadcastMessageInput,
  type BroadcastMessageOutput,
  type GetMessagesInput,
  type InboxOutput,
  type ListAgentsInput,
  type ListAgentsOutput,
  type MarkMessagesReadInput,
  type MarkMessagesReadOutput,
  type MessageContextDto,
  type RegisterAgentInput,
  type RegisterAgentOutput,
  type SendMessageInput,
  type SendMessageOutput,
  type WaitForMessagesInput,
  type WaitForMessagesOutput,
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
  AgentId,
  BoundedJsonObjectSchema,
  type AgentClient,
  type BranchName,
  Instant,
  type JsonObject,
  MachineName,
  type RepositoryName,
  Sequence,
  TenantId,
} from "../domain/value-objects.js";
import {
  BootstrapOperatorInputSchema,
  CreateOperatorTokenInputSchema,
  CreateTenantInputSchema,
  CreateTenantOutputSchema,
  CreateTokenInputSchema,
  IssuedOperatorTokenOutputSchema,
  IssuedTokenOutputSchema,
  ListAdminAuditInputSchema,
  ListAdminAuditOutputSchema,
  ListOperatorTokensInputSchema,
  ListOperatorTokensOutputSchema,
  ListTenantsInputSchema,
  ListTenantsOutputSchema,
  ListTokensInputSchema,
  ListTokensOutputSchema,
  MintTenantAdminTokenInputSchema,
  RevokeTokenInputSchema,
  RevokeTokenOutputSchema,
  TenantIdInputSchema,
  TenantStatusOutputSchema,
  toAdminAuditEventDto,
  toIssuedOperatorTokenDto,
  toIssuedTokenDto,
  toOperatorTokenSummaryDto,
  toTenantSummaryDto,
  toTokenSummaryDto,
  type BootstrapOperatorInput,
  type CreateOperatorTokenInput,
  type CreateTenantInput,
  type CreateTenantOutput,
  type CreateTokenInput,
  type IssuedOperatorTokenOutput,
  type IssuedTokenOutput,
  type ListAdminAuditInput,
  type ListAdminAuditOutput,
  type ListOperatorTokensInput,
  type ListOperatorTokensOutput,
  type ListTenantsInput,
  type ListTenantsOutput,
  type ListTokensInput,
  type ListTokensOutput,
  type MintTenantAdminTokenInput,
  type RevokeTokenInput,
  type RevokeTokenOutput,
  type TenantIdInput,
  type TenantStatusOutput,
} from "../hosted/contracts.js";
import type {
  AdminAuditEvent,
  HostedControlPlane,
  HostedPrincipal,
  IssuedOperatorToken,
  IssuedToken,
  OperatorPrincipal,
  OperatorTokenSummary,
  Page,
  TenantSummary,
  TenantPrincipal,
  TokenSummary,
} from "../hosted/control-plane.js";
import type {
  InboxSubscription,
  InboxUpdateHandler,
  MessageStore,
} from "../storage/message-store.js";
import { logSafeError, safeErrorMessage } from "../safe-errors.js";

const SERVER_VERSION: string = packageMetadata.version;
const INBOX_PREFIX: string = "murmur://inbox/";
const MAX_INBOX_SUBSCRIPTIONS_PER_SESSION: number = 10;

type ListedResource = ListResourcesResult["resources"][number];

type ActiveInboxSubscription = {
  readonly storeSubscription: InboxSubscription;
};

type RequiredMessageContext = {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly repositoryName: RepositoryName;
};

export type MurmurApplicationDependencies = {
  readonly branchName: BranchName | null;
  readonly bootstrapCredentialHash?: Buffer | null;
  readonly client: AgentClient | null;
  readonly closeStoreOnClose?: boolean;
  readonly controlPlane?: HostedControlPlane | null;
  readonly legacyCredentialHash?: Buffer | null;
  readonly onTenantSuspended?: ((tenantId: TenantId) => Promise<void>) | undefined;
  readonly onTokenRevoked?: ((tokenId: string) => Promise<void>) | undefined;
  readonly principal?: HostedPrincipal | null;
  readonly repositoryName: RepositoryName | null;
  readonly store: MessageStore | null;
  readonly tenantOnboardingEnabled?: boolean;
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
  const message: string = safeErrorMessage(error);
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

function machineNameFromAgentId(agentId: AgentId): MachineName | null {
  const separatorIndex: number = agentId.value.indexOf(":");
  if (separatorIndex <= 0) return null;
  try {
    return MachineName.parse(agentId.value.slice(0, separatorIndex));
  } catch (_error: unknown) {
    return null;
  }
}

export class MurmurApplication {
  public readonly server: Server;
  private readonly bootstrapCredentialHash: Buffer | null;
  private readonly closeStoreOnClose: boolean;
  private readonly branchName: BranchName | null;
  private readonly client: AgentClient | null;
  private readonly controlPlane: HostedControlPlane | null;
  private readonly legacyCredentialHash: Buffer | null;
  private readonly onTenantSuspended: ((tenantId: TenantId) => Promise<void>) | null;
  private readonly onTokenRevoked: ((tokenId: string) => Promise<void>) | null;
  private readonly principal: HostedPrincipal | null;
  private readonly repositoryName: RepositoryName | null;
  private readonly store: MessageStore | null;
  private readonly subscriptions: Map<string, ActiveInboxSubscription>;
  private readonly tools: Tool[];
  private readonly tenantOnboardingEnabled: boolean;
  private closed: boolean;
  private subscriptionMutationQueue: Promise<void>;

  public constructor(dependencies: MurmurApplicationDependencies) {
    this.branchName = dependencies.branchName;
    this.bootstrapCredentialHash =
      dependencies.bootstrapCredentialHash === undefined ||
      dependencies.bootstrapCredentialHash === null
        ? null
        : Buffer.from(dependencies.bootstrapCredentialHash);
    this.client = dependencies.client;
    this.closeStoreOnClose = dependencies.closeStoreOnClose !== false;
    this.controlPlane = dependencies.controlPlane ?? null;
    this.legacyCredentialHash = dependencies.legacyCredentialHash ?? null;
    this.onTenantSuspended = dependencies.onTenantSuspended ?? null;
    this.onTokenRevoked = dependencies.onTokenRevoked ?? null;
    this.principal = dependencies.principal ?? null;
    this.repositoryName = dependencies.repositoryName;
    this.store = dependencies.store;
    this.subscriptions = new Map<string, ActiveInboxSubscription>();
    this.subscriptionMutationQueue = Promise.resolve();
    this.tenantOnboardingEnabled = dependencies.tenantOnboardingEnabled === true;
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
          "Murmur provides durable agent-to-agent inboxes. Call register_agent first, then send_message, broadcast_message, or get_messages. " +
          "Outgoing messages include context.repository, context.branch, context.client, and a created_at timestamp. " +
          "Repository, branch, and client are detected from the launching agent when possible; otherwise send_message or broadcast_message must supply them in context. " +
          "For push signals, subscribe to murmur://inbox/{agent_id}; always read the durable inbox after a notification or reconnect. " +
          `Messages expire automatically after ${RETENTION_DAYS} days. MCP notifications do not themselves guarantee that a host starts a new model turn.`,
      },
    );
    this.registerRequestHandlers();
    this.server.onclose = (): void => {
      void this.closeResources().catch((error: unknown): void => {
        logSafeError("Murmur resource shutdown failed", error);
      });
    };
  }

  private createTools(): Tool[] {
    if (this.principal !== null && this.principal.kind === "bootstrap") {
      return this.isBootstrapPrincipal() ? this.bootstrapTools() : [];
    }
    if (this.principal !== null && this.principal.kind === "operator") {
      return this.operatorTools();
    }
    const tools: Tool[] = this.dataTools();
    if (
      this.principal !== null &&
      this.principal.kind === "tenant" &&
      this.principal.role === "tenant_admin"
    ) {
      tools.push(...this.tenantAdminTools());
    }
    return tools;
  }

  private dataTools(): Tool[] {
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
        "broadcast_message",
        "Broadcast agent message",
        `Persist one durable inbox delivery for every agent refreshed in the last ${ACTIVE_AGENT_WINDOW_MINUTES} minutes that matches the optional audience filters. Repository and machine filters combine with AND; omit both to broadcast globally. The sender is excluded, and idempotent retries preserve the original recipient snapshot.`,
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

  private tenantAdminTools(): Tool[] {
    return [
      toolDefinition(
        "create_access_token",
        "Create tenant access token",
        "Create an agent or tenant-administrator token for the authenticated tenant. The secret is returned exactly once; store it securely.",
        CreateTokenInputSchema,
        IssuedTokenOutputSchema,
        {
          destructiveHint: false,
          idempotentHint: false,
          readOnlyHint: false,
          title: "Create tenant access token",
        },
      ),
      toolDefinition(
        "list_access_tokens",
        "List tenant access tokens",
        "List one cursor-paginated page of token identifiers and lifecycle timestamps for the authenticated tenant. Token secrets are never returned.",
        ListTokensInputSchema,
        ListTokensOutputSchema,
        {
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: true,
          title: "List tenant access tokens",
        },
      ),
      toolDefinition(
        "revoke_access_token",
        "Revoke tenant access token",
        "Immediately revoke one access token in the authenticated tenant and close its live MCP sessions.",
        RevokeTokenInputSchema,
        RevokeTokenOutputSchema,
        {
          destructiveHint: true,
          idempotentHint: true,
          readOnlyHint: false,
          title: "Revoke tenant access token",
        },
      ),
    ];
  }

  private bootstrapTools(): Tool[] {
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

  private operatorTools(): Tool[] {
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
        {
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: true,
          title: "List tenants",
        },
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
        {
          destructiveHint: true,
          idempotentHint: true,
          readOnlyHint: false,
          title: "Suspend tenant",
        },
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
      if (!this.tenantOnboardingEnabled && tool.name === "create_tenant") return false;
      if (this.legacyCredentialHash === null && tool.name === "adopt_legacy_founding_token") {
        return false;
      }
      return true;
    });
  }

  private dataStore(): MessageStore {
    if (this.store === null) throw new Error("This credential cannot access tenant data");
    return this.store;
  }

  private hostedControlPlane(): HostedControlPlane {
    if (this.controlPlane === null) {
      throw new Error("Hosted tenant administration requires Postgres multi-tenant storage");
    }
    return this.controlPlane;
  }

  private tenantAdministrator(): TenantPrincipal {
    if (
      this.principal === null ||
      this.principal.kind !== "tenant" ||
      this.principal.role !== "tenant_admin"
    ) {
      throw new Error("Unknown tool");
    }
    return this.principal;
  }

  private requireOperator(): OperatorPrincipal {
    if (this.principal === null || this.principal.kind !== "operator") {
      throw new Error("Unknown tool");
    }
    return this.principal;
  }

  private isBootstrapPrincipal(): boolean {
    return (
      this.bootstrapCredentialHash !== null &&
      this.principal !== null &&
      this.principal.kind === "bootstrap"
    );
  }

  private requireBootstrapPrincipal(): Buffer {
    if (!this.isBootstrapPrincipal()) throw new Error("Unknown tool");
    const credentialHash: Buffer | null = this.bootstrapCredentialHash;
    if (credentialHash === null) throw new Error("Unknown tool");
    return credentialHash;
  }

  private expiration(value: string | undefined): Instant | null {
    return value === undefined ? null : Instant.parse(value);
  }

  private requiredMessageContext(input: MessageContextDto | undefined): RequiredMessageContext {
    const repositoryName: RepositoryName | null = repositoryNameFromInput(
      input,
      this.repositoryName,
    );
    if (repositoryName === null) {
      throw new Error(
        "Message repository context is required. Supply context.repository or configure MURMUR_REPOSITORY/X-Murmur-Repository.",
      );
    }
    const branchName: BranchName | null = branchNameFromInput(input, this.branchName);
    if (branchName === null) {
      throw new Error(
        "Message branch context is required. Supply context.branch or configure MURMUR_BRANCH/X-Murmur-Branch.",
      );
    }
    const client: AgentClient | null = agentClientFromInput(input, this.client);
    if (client === null) {
      throw new Error(
        "Message client context is required. Supply context.client or configure MURMUR_CLIENT/X-Murmur-Client.",
      );
    }
    return { branchName, client, repositoryName };
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
        resources: (this.store === null ? [] : await this.store.listAgents()).map(
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
        resourceTemplates:
          this.store === null
            ? []
            : [
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
      async (request: SubscribeRequest): Promise<Record<string, never>> =>
        await this.serializeSubscriptionMutation(async (): Promise<Record<string, never>> => {
          if (this.closed) throw new McpError(ErrorCode.InvalidRequest, "Session is closed.");
          const uri: string = request.params.uri;
          const agentId: AgentId = agentIdFromInboxUri(uri);
          const store: MessageStore = this.dataStore();
          const existing: ActiveInboxSubscription | undefined = this.subscriptions.get(uri);
          if (
            existing === undefined &&
            this.subscriptions.size >= MAX_INBOX_SUBSCRIPTIONS_PER_SESSION
          ) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Inbox subscription capacity reached (${MAX_INBOX_SUBSCRIPTIONS_PER_SESSION} per session).`,
            );
          }
          if ((await store.getAgent(agentId)) === null) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Unknown agent '${agentId.value}'. Register it first.`,
            );
          }
          if (existing !== undefined) {
            await existing.storeSubscription.close();
            this.subscriptions.delete(uri);
          }
          let latestSequence: Sequence = await store.getInboxVersion(agentId);
          const handler: InboxUpdateHandler = async (sequence: Sequence): Promise<void> => {
            if (!sequence.isAfter(latestSequence) || this.closed) return;
            await this.server.sendResourceUpdated({ uri });
            latestSequence = sequence;
          };
          const storeSubscription: InboxSubscription = await store.watchInbox(
            agentId,
            latestSequence,
            handler,
          );
          this.subscriptions.set(uri, { storeSubscription });
          return {};
        }),
    );
    this.server.setRequestHandler(
      UnsubscribeRequestSchema,
      async (request: UnsubscribeRequest): Promise<Record<string, never>> =>
        await this.serializeSubscriptionMutation(async (): Promise<Record<string, never>> => {
          const subscription: ActiveInboxSubscription | undefined = this.subscriptions.get(
            request.params.uri,
          );
          if (subscription !== undefined) await subscription.storeSubscription.close();
          this.subscriptions.delete(request.params.uri);
          return {};
        }),
    );
  }

  private async serializeSubscriptionMutation<T>(action: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.subscriptionMutationQueue.then(action, action);
    this.subscriptionMutationQueue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return await result;
  }

  private async callTool(request: CallToolRequest): Promise<CallToolResult> {
    try {
      switch (request.params.name) {
        case "register_agent": {
          const store: MessageStore = this.dataStore();
          const input: RegisterAgentInput = RegisterAgentInputSchema.parse(
            request.params.arguments,
          );
          const parsedCommand: RegisterAgentCommand = registerAgentCommand(input);
          const inferredMachine: MachineName | null = machineNameFromAgentId(parsedCommand.agentId);
          const metadata: JsonObject = BoundedJsonObjectSchema.parse({
            ...(inferredMachine === null ? {} : { machine: inferredMachine.value }),
            ...parsedCommand.metadata,
            ...(this.client === null ? {} : { client: this.client.value }),
            ...(this.repositoryName === null ? {} : { repository: this.repositoryName.value }),
          });
          const command: RegisterAgentCommand = { ...parsedCommand, metadata };
          const wasKnown: boolean = (await store.getAgent(command.agentId)) !== null;
          const agent: Agent = await store.registerAgent(command);
          if (!wasKnown) await this.server.sendResourceListChanged();
          const output: RegisterAgentOutput = RegisterAgentOutputSchema.parse({
            agent: toAgentDto(agent),
            inbox_uri: inboxUri(command.agentId),
            retention_days: RETENTION_DAYS,
          });
          return toolResult(output);
        }
        case "list_agents": {
          const store: MessageStore = this.dataStore();
          const input: ListAgentsInput = ListAgentsInputSchema.parse(request.params.arguments);
          const output: ListAgentsOutput = ListAgentsOutputSchema.parse({
            agents: (await store.listAgents()).map(toAgentDto),
          });
          if (Object.keys(input).length !== 0) throw new Error("list_agents takes no arguments");
          return toolResult(output);
        }
        case "send_message": {
          const store: MessageStore = this.dataStore();
          const input: SendMessageInput = SendMessageInputSchema.parse(request.params.arguments);
          const context: RequiredMessageContext = this.requiredMessageContext(input.context);
          const command: SendMessageCommand = {
            branchName: context.branchName,
            client: context.client,
            content: parseContent(input.content),
            idempotencyKey: nullableIdempotencyKey(input.idempotency_key),
            recipientId: AgentId.parse(input.recipient_id),
            repositoryName: context.repositoryName,
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
          const store: MessageStore = this.dataStore();
          const input: BroadcastMessageInput = BroadcastMessageInputSchema.parse(
            request.params.arguments,
          );
          const context: RequiredMessageContext = this.requiredMessageContext(input.context);
          const command: BroadcastMessageCommand = {
            audience: broadcastAudienceFromInput(input.audience),
            branchName: context.branchName,
            client: context.client,
            content: parseContent(input.content),
            idempotencyKey: nullableIdempotencyKey(input.idempotency_key),
            repositoryName: context.repositoryName,
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
          const store: MessageStore = this.dataStore();
          const input: GetMessagesInput = GetMessagesInputSchema.parse(request.params.arguments);
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
          const input: WaitForMessagesInput = WaitForMessagesInputSchema.parse(
            request.params.arguments,
          );
          return await this.waitForMessages(input);
        }
        case "mark_messages_read": {
          const store: MessageStore = this.dataStore();
          const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(
            request.params.arguments,
          );
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
        case "create_access_token": {
          const principal: TenantPrincipal = this.tenantAdministrator();
          const input: CreateTokenInput = CreateTokenInputSchema.parse(request.params.arguments);
          const token: IssuedToken = await this.hostedControlPlane().createToken(
            principal.tenantId,
            input.role,
            input.name,
            this.expiration(input.expires_at),
          );
          const output: IssuedTokenOutput = IssuedTokenOutputSchema.parse({
            token: toIssuedTokenDto(token),
          });
          return toolResult(output);
        }
        case "list_access_tokens": {
          const principal: TenantPrincipal = this.tenantAdministrator();
          const input: ListTokensInput = ListTokensInputSchema.parse(request.params.arguments);
          const tokenPage: Page<TokenSummary> = await this.hostedControlPlane().listTokens(
            principal.tenantId,
            input.cursor ?? null,
            input.limit ?? 100,
          );
          const output: ListTokensOutput = ListTokensOutputSchema.parse({
            next_cursor: tokenPage.nextCursor,
            tokens: tokenPage.items.map(toTokenSummaryDto),
          });
          return toolResult(output);
        }
        case "revoke_access_token": {
          const principal: TenantPrincipal = this.tenantAdministrator();
          const input: RevokeTokenInput = RevokeTokenInputSchema.parse(request.params.arguments);
          const tokenId: string | null = await this.hostedControlPlane().revokeToken(
            principal.tenantId,
            input.key_id,
          );
          if (tokenId !== null && this.onTokenRevoked !== null) {
            await this.onTokenRevoked(tokenId);
          }
          const output: RevokeTokenOutput = RevokeTokenOutputSchema.parse({
            revoked: tokenId !== null,
          });
          return toolResult(output);
        }
        case "bootstrap_operator": {
          const bootstrapCredentialHash: Buffer = this.requireBootstrapPrincipal();
          const input: BootstrapOperatorInput = BootstrapOperatorInputSchema.parse(
            request.params.arguments,
          );
          const token: IssuedOperatorToken = await this.hostedControlPlane().bootstrapOperatorToken(
            bootstrapCredentialHash,
            input.name,
            input.secret,
          );
          const output: IssuedOperatorTokenOutput = IssuedOperatorTokenOutputSchema.parse({
            token: toIssuedOperatorTokenDto(token),
          });
          return toolResult(output);
        }
        case "adopt_legacy_founding_token": {
          const principal: OperatorPrincipal = this.requireOperator();
          if (this.legacyCredentialHash === null) throw new Error("Unknown tool");
          z.strictObject({}).parse(request.params.arguments);
          const changed: boolean = await this.hostedControlPlane().adoptLegacyFoundingToken(
            principal,
            this.legacyCredentialHash,
          );
          const output: TenantStatusOutput = TenantStatusOutputSchema.parse({ changed });
          return toolResult(output);
        }
        case "create_operator_token": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: CreateOperatorTokenInput = CreateOperatorTokenInputSchema.parse(
            request.params.arguments,
          );
          const token: IssuedOperatorToken = await this.hostedControlPlane().createOperatorToken(
            principal,
            input.name,
            this.expiration(input.expires_at),
          );
          const output: IssuedOperatorTokenOutput = IssuedOperatorTokenOutputSchema.parse({
            token: toIssuedOperatorTokenDto(token),
          });
          return toolResult(output);
        }
        case "list_operator_tokens": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: ListOperatorTokensInput = ListOperatorTokensInputSchema.parse(
            request.params.arguments,
          );
          const tokenPage: Page<OperatorTokenSummary> =
            await this.hostedControlPlane().listOperatorTokens(
              principal,
              input.cursor ?? null,
              input.limit ?? 100,
            );
          const output: ListOperatorTokensOutput = ListOperatorTokensOutputSchema.parse({
            next_cursor: tokenPage.nextCursor,
            tokens: tokenPage.items.map(toOperatorTokenSummaryDto),
          });
          return toolResult(output);
        }
        case "revoke_operator_token": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: RevokeTokenInput = RevokeTokenInputSchema.parse(request.params.arguments);
          const tokenId: string | null = await this.hostedControlPlane().revokeOperatorToken(
            principal,
            input.key_id,
          );
          if (tokenId !== null && this.onTokenRevoked !== null) {
            await this.onTokenRevoked(tokenId);
          }
          const output: RevokeTokenOutput = RevokeTokenOutputSchema.parse({
            revoked: tokenId !== null,
          });
          return toolResult(output);
        }
        case "list_admin_audit": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: ListAdminAuditInput = ListAdminAuditInputSchema.parse(
            request.params.arguments,
          );
          const events: readonly AdminAuditEvent[] = await this.hostedControlPlane().listAdminAudit(
            principal,
            input.limit,
          );
          const output: ListAdminAuditOutput = ListAdminAuditOutputSchema.parse({
            events: events.map(toAdminAuditEventDto),
          });
          return toolResult(output);
        }
        case "create_tenant": {
          const principal: OperatorPrincipal = this.requireOperator();
          if (!this.tenantOnboardingEnabled) throw new Error("Unknown tool");
          const input: CreateTenantInput = CreateTenantInputSchema.parse(request.params.arguments);
          const created: {
            readonly tenant: TenantSummary;
            readonly token: IssuedToken;
          } = await this.hostedControlPlane().createTenant(
            principal,
            input.slug,
            input.display_name,
          );
          const output: CreateTenantOutput = CreateTenantOutputSchema.parse({
            tenant: toTenantSummaryDto(created.tenant),
            token: toIssuedTokenDto(created.token),
          });
          return toolResult(output);
        }
        case "list_tenants": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: ListTenantsInput = ListTenantsInputSchema.parse(request.params.arguments);
          const tenantPage: Page<TenantSummary> = await this.hostedControlPlane().listTenants(
            principal,
            input.cursor ?? null,
            input.limit ?? 100,
          );
          const output: ListTenantsOutput = ListTenantsOutputSchema.parse({
            next_cursor: tenantPage.nextCursor,
            tenants: tenantPage.items.map(toTenantSummaryDto),
          });
          return toolResult(output);
        }
        case "mint_tenant_admin_token": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: MintTenantAdminTokenInput = MintTenantAdminTokenInputSchema.parse(
            request.params.arguments,
          );
          const token: IssuedToken = await this.hostedControlPlane().mintTenantAdminToken(
            principal,
            TenantId.parse(input.tenant_id),
            input.name,
            this.expiration(input.expires_at),
          );
          const output: IssuedTokenOutput = IssuedTokenOutputSchema.parse({
            token: toIssuedTokenDto(token),
          });
          return toolResult(output);
        }
        case "suspend_tenant": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: TenantIdInput = TenantIdInputSchema.parse(request.params.arguments);
          const tenantId: TenantId = TenantId.parse(input.tenant_id);
          const changed: boolean = await this.hostedControlPlane().suspendTenant(
            principal,
            tenantId,
          );
          if (changed && this.onTenantSuspended !== null) await this.onTenantSuspended(tenantId);
          const output: TenantStatusOutput = TenantStatusOutputSchema.parse({
            changed,
          });
          return toolResult(output);
        }
        case "restore_tenant": {
          const principal: OperatorPrincipal = this.requireOperator();
          const input: TenantIdInput = TenantIdInputSchema.parse(request.params.arguments);
          const output: TenantStatusOutput = TenantStatusOutputSchema.parse({
            changed: await this.hostedControlPlane().restoreTenant(
              principal,
              TenantId.parse(input.tenant_id),
            ),
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
    const store: MessageStore = this.dataStore();
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
      const subscription: InboxSubscription = await store.watchInbox(
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

  private async readResource(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const store: MessageStore = this.dataStore();
    const uri: string = request.params.uri;
    const agentId: AgentId = agentIdFromInboxUri(uri);
    const query: GetMessagesQuery = {
      afterSequence: Sequence.zero(),
      agentId,
      limit: 500,
      threadId: null,
      unreadOnly: false,
    };
    const messages: readonly Message[] = await store.getMessages(query);
    const inboxVersion: Sequence = await store.getInboxVersion(agentId);
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
    await this.subscriptionMutationQueue;
    const subscriptions: readonly ActiveInboxSubscription[] = Array.from(
      this.subscriptions.values(),
    );
    this.subscriptions.clear();
    const results: PromiseSettledResult<void>[] = await Promise.allSettled(
      subscriptions.map(
        async (subscription: ActiveInboxSubscription): Promise<void> =>
          await subscription.storeSubscription.close(),
      ),
    );
    results.forEach((result: PromiseSettledResult<void>): void => {
      if (result.status === "rejected") {
        logSafeError("Murmur inbox subscription shutdown failed", result.reason);
      }
    });
    if (this.closeStoreOnClose && this.store !== null) await this.store.close();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.closeResources();
    await this.server.close();
  }
}
