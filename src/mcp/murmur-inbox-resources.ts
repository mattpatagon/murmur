import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceRequest,
  ReadResourceResult,
  ServerNotification,
  ServerRequest,
  SubscribeRequest,
  UnsubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  encodeAgentCursor,
  type InboxOutput,
  InboxOutputSchema,
  ListAgentsInputSchema,
  listAgentsQuery,
  toMessageDto,
} from "../domain/contracts.js";
import type { Agent, GetMessagesQuery, ListAgentsResult } from "../domain/models.js";
import { AgentId, Sequence } from "../domain/value-objects.js";
import { logSafeError, safeErrorMessage } from "../safe-errors.js";
import type {
  InboxReadResult,
  InboxSubscription,
  InboxUpdateHandler,
  MessageStore,
} from "../storage/message-store.js";
import { normalizePostgresStorageError } from "../storage/postgres-storage-errors.js";
import { ResourceMutationQueue } from "./resource-mutation-queue.js";

const INBOX_PREFIX: string = "murmur://inbox/";
const MAX_INBOX_SUBSCRIPTIONS_PER_SESSION: number = 10;
type ListedResource = ListResourcesResult["resources"][number];
type ActiveInboxSubscription = { readonly storeSubscription: InboxSubscription };

async function safeStorageRequest<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    // SDK resource errors otherwise serialize the original exception message and data.
    if (
      typeof error !== "object" ||
      error === null ||
      typeof Reflect.get(error, "code") !== "string"
    ) {
      throw error;
    }
    logSafeError("Murmur resource storage request failed", error);
    throw new McpError(
      ErrorCode.InternalError,
      safeErrorMessage(normalizePostgresStorageError(error)),
    );
  }
}

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

export class MurmurInboxResources {
  private closed: boolean;
  private readonly closeStoreOnClose: boolean;
  private readonly server: Server;
  private readonly store: MessageStore | null;
  private readonly subscriptions: Map<string, ActiveInboxSubscription>;
  private readonly mutationQueue: ResourceMutationQueue;

  public constructor(server: Server, store: MessageStore | null, closeStoreOnClose: boolean) {
    this.closed = false;
    this.closeStoreOnClose = closeStoreOnClose;
    this.mutationQueue = new ResourceMutationQueue();
    this.server = server;
    this.store = store;
    this.subscriptions = new Map<string, ActiveInboxSubscription>();
  }

  private dataStore(): MessageStore {
    if (this.store === null) throw new Error("This credential cannot access tenant data");
    return this.store;
  }

  private requireActiveMutation(signal: AbortSignal): void {
    if (this.closed) throw new McpError(ErrorCode.InvalidRequest, "Session is closed.");
    if (signal.aborted) {
      throw new McpError(ErrorCode.InvalidRequest, "Inbox mutation request was canceled.");
    }
  }

  private async readResource(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const store: MessageStore = this.dataStore();
    const uri: string = request.params.uri;
    const agentId: AgentId = agentIdFromInboxUri(uri);
    const query: GetMessagesQuery = {
      afterSequence: Sequence.zero(),
      agentId,
      generation: null,
      limit: 500,
      sessionKey: null,
      threadId: null,
      unreadOnly: false,
    };
    const { messages, inboxVersion }: InboxReadResult = await store.getMessagesWithVersion(query);
    const output: InboxOutput = InboxOutputSchema.parse({
      agent_id: agentId.value,
      inbox_version: inboxVersion.value,
      messages: messages.map(toMessageDto),
    });
    return {
      contents: [{ mimeType: "application/json", text: JSON.stringify(output, null, 2), uri }],
    };
  }

  private async subscribe(
    request: SubscribeRequest,
    signal: AbortSignal,
  ): Promise<Record<string, never>> {
    return await this.mutationQueue.run(async (): Promise<Record<string, never>> => {
      this.requireActiveMutation(signal);
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
      this.requireActiveMutation(signal);
      if (existing !== undefined) {
        await existing.storeSubscription.close();
        this.subscriptions.delete(uri);
      }
      this.requireActiveMutation(signal);
      let latestSequence: Sequence = await store.getInboxVersion(agentId);
      this.requireActiveMutation(signal);
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
      if (this.closed || signal.aborted) {
        await storeSubscription.close();
        this.requireActiveMutation(signal);
      }
      this.subscriptions.set(uri, { storeSubscription });
      return {};
    }, signal);
  }

  private async unsubscribe(
    request: UnsubscribeRequest,
    signal: AbortSignal,
  ): Promise<Record<string, never>> {
    return await this.mutationQueue.run(async (): Promise<Record<string, never>> => {
      this.requireActiveMutation(signal);
      const subscription: ActiveInboxSubscription | undefined = this.subscriptions.get(
        request.params.uri,
      );
      if (subscription !== undefined) await subscription.storeSubscription.close();
      this.subscriptions.delete(request.params.uri);
      return {};
    }, signal);
  }

  public registerHandlers(): void {
    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (request: ListResourcesRequest): Promise<ListResourcesResult> =>
        await safeStorageRequest(async (): Promise<ListResourcesResult> => {
          if (this.store === null) return { resources: [] };
          const cursor: string | undefined =
            request.params === undefined ? undefined : request.params.cursor;
          const page: ListAgentsResult = await this.store.listAgents(
            listAgentsQuery(ListAgentsInputSchema.parse({ cursor, limit: 1_000, state: "active" })),
          );
          return {
            ...(page.nextCursor === null ? {} : { nextCursor: encodeAgentCursor(page.nextCursor) }),
            resources: page.agents.map(
              (agent: Agent): ListedResource => ({
                description: `Durable inbox for ${agent.agentId.value}`,
                mimeType: "application/json",
                name: `${agent.displayName.value} inbox`,
                uri: inboxUri(agent.agentId),
              }),
            ),
          };
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
        await safeStorageRequest(
          async (): Promise<ReadResourceResult> => await this.readResource(request),
        ),
    );
    this.server.setRequestHandler(
      SubscribeRequestSchema,
      async (
        request: SubscribeRequest,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<Record<string, never>> =>
        await safeStorageRequest(
          async (): Promise<Record<string, never>> => await this.subscribe(request, extra.signal),
        ),
    );
    this.server.setRequestHandler(
      UnsubscribeRequestSchema,
      async (
        request: UnsubscribeRequest,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<Record<string, never>> =>
        await safeStorageRequest(
          async (): Promise<Record<string, never>> => await this.unsubscribe(request, extra.signal),
        ),
    );
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.mutationQueue.close();
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
}
