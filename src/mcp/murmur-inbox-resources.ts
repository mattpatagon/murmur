import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceRequest,
  ReadResourceResult,
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

import { type InboxOutput, InboxOutputSchema, toMessageDto } from "../domain/contracts.js";
import type { Agent, GetMessagesQuery, Message } from "../domain/models.js";
import { AgentId, Sequence } from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type {
  InboxSubscription,
  InboxUpdateHandler,
  MessageStore,
} from "../storage/message-store.js";

const INBOX_PREFIX: string = "murmur://inbox/";
const MAX_INBOX_SUBSCRIPTIONS_PER_SESSION: number = 10;
type ListedResource = ListResourcesResult["resources"][number];
type ActiveInboxSubscription = { readonly storeSubscription: InboxSubscription };

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
  private mutationQueue: Promise<void>;

  public constructor(server: Server, store: MessageStore | null, closeStoreOnClose: boolean) {
    this.closed = false;
    this.closeStoreOnClose = closeStoreOnClose;
    this.mutationQueue = Promise.resolve();
    this.server = server;
    this.store = store;
    this.subscriptions = new Map<string, ActiveInboxSubscription>();
  }

  private dataStore(): MessageStore {
    if (this.store === null) throw new Error("This credential cannot access tenant data");
    return this.store;
  }

  private async serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.mutationQueue.then(action, action);
    this.mutationQueue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return await result;
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
      contents: [{ mimeType: "application/json", text: JSON.stringify(output, null, 2), uri }],
    };
  }

  private async subscribe(request: SubscribeRequest): Promise<Record<string, never>> {
    return await this.serializeMutation(async (): Promise<Record<string, never>> => {
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
    });
  }

  private async unsubscribe(request: UnsubscribeRequest): Promise<Record<string, never>> {
    return await this.serializeMutation(async (): Promise<Record<string, never>> => {
      const subscription: ActiveInboxSubscription | undefined = this.subscriptions.get(
        request.params.uri,
      );
      if (subscription !== undefined) await subscription.storeSubscription.close();
      this.subscriptions.delete(request.params.uri);
      return {};
    });
  }

  public registerHandlers(): void {
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
        await this.subscribe(request),
    );
    this.server.setRequestHandler(
      UnsubscribeRequestSchema,
      async (request: UnsubscribeRequest): Promise<Record<string, never>> =>
        await this.unsubscribe(request),
    );
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.mutationQueue;
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
