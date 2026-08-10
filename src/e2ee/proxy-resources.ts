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

import { AgentId } from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type { ProxyInboxOutput, ProxyMessageDto } from "./proxy-contracts.js";
import type { E2eeProxyOperations } from "./proxy-service.js";

const INBOX_PREFIX: string = "murmur://inbox/";
const MAX_INBOX_SUBSCRIPTIONS_PER_SESSION: number = 10;
const SUBSCRIPTION_WAIT_SECONDS: number = 5;
type ListedResource = ListResourcesResult["resources"][number];

type ActiveSubscription = {
  readonly cancel: () => void;
  readonly task: Promise<void>;
};

function inboxUri(agentId: string): string {
  return `${INBOX_PREFIX}${encodeURIComponent(agentId)}`;
}

function agentIdFromInboxUri(uri: string): string {
  if (!uri.startsWith(INBOX_PREFIX)) {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI '${uri}'`);
  }
  const encoded: string = uri.slice(INBOX_PREFIX.length);
  if (encoded === "" || encoded.includes("/")) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid inbox resource URI '${uri}'`);
  }
  try {
    return AgentId.parse(decodeURIComponent(encoded)).value;
  } catch (error: unknown) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid inbox resource URI '${uri}'`, {
      cause: error,
    });
  }
}

function newestSequence(messages: readonly ProxyMessageDto[], fallback: number): number {
  let latest: number = fallback;
  messages.forEach((message: ProxyMessageDto): void => {
    if (message.sequence > latest) latest = message.sequence;
  });
  return latest;
}

export class E2eeProxyResources {
  #closed: boolean = false;
  readonly #operations: E2eeProxyOperations;
  readonly #server: Server;
  readonly #subscriptions: Map<string, ActiveSubscription> = new Map<string, ActiveSubscription>();
  #mutationQueue: Promise<void> = Promise.resolve();

  public constructor(server: Server, operations: E2eeProxyOperations) {
    this.#operations = operations;
    this.#server = server;
  }

  private async serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.#mutationQueue.then(action, action);
    this.#mutationQueue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return await result;
  }

  private async listResources(): Promise<ListResourcesResult> {
    const agents: Awaited<ReturnType<E2eeProxyOperations["listAgents"]>> =
      await this.#operations.listAgents({ limit: 1_000, state: "active" });
    return {
      resources: agents.agents.map(
        (agent: (typeof agents.agents)[number]): ListedResource => ({
          description: `End-to-end encrypted inbox for ${agent.agent_id}`,
          mimeType: "application/json",
          name: `${agent.display_name} encrypted inbox`,
          uri: inboxUri(agent.agent_id),
        }),
      ),
    };
  }

  private async readResource(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const uri: string = request.params.uri;
    const agentId: string = agentIdFromInboxUri(uri);
    const inbox: ProxyInboxOutput = await this.#operations.getMessages({
      after_sequence: 0,
      agent_id: agentId,
      limit: 500,
      unread_only: false,
    });
    return {
      contents: [{ mimeType: "application/json", text: JSON.stringify(inbox, null, 2), uri }],
    };
  }

  private startSubscription(uri: string, agentId: string): ActiveSubscription {
    let cancelled: boolean = false;
    const cancel: () => void = (): void => {
      cancelled = true;
    };
    const task: Promise<void> = (async (): Promise<void> => {
      let afterSequence: number = 0;
      while (!cancelled && !this.#closed) {
        let result: Awaited<ReturnType<E2eeProxyOperations["waitForMessages"]>>;
        try {
          result = await this.#operations.waitForMessages({
            after_sequence: afterSequence,
            agent_id: agentId,
            timeout_seconds: SUBSCRIPTION_WAIT_SECONDS,
          });
        } catch (error: unknown) {
          if (!cancelled && !this.#closed) {
            logSafeError("Murmur encrypted inbox subscription stopped", error);
          }
          return;
        }
        if (cancelled || this.#closed) return;
        const nextSequence: number = newestSequence(result.messages, afterSequence);
        if (nextSequence > afterSequence) {
          await this.#server.sendResourceUpdated({ uri });
          afterSequence = nextSequence;
        }
      }
    })();
    return { cancel, task };
  }

  private async subscribe(request: SubscribeRequest): Promise<Record<string, never>> {
    return await this.serializeMutation(async (): Promise<Record<string, never>> => {
      if (this.#closed) throw new McpError(ErrorCode.InvalidRequest, "Session is closed.");
      const uri: string = request.params.uri;
      const agentId: string = agentIdFromInboxUri(uri);
      const existing: ActiveSubscription | undefined = this.#subscriptions.get(uri);
      if (
        existing === undefined &&
        this.#subscriptions.size >= MAX_INBOX_SUBSCRIPTIONS_PER_SESSION
      ) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Inbox subscription capacity reached (${MAX_INBOX_SUBSCRIPTIONS_PER_SESSION} per session).`,
        );
      }
      const agents: Awaited<ReturnType<E2eeProxyOperations["listAgents"]>> =
        await this.#operations.listAgents({ limit: 1_000, state: "active" });
      if (
        !agents.agents.some(
          (agent: (typeof agents.agents)[number]): boolean => agent.agent_id === agentId,
        )
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown agent '${agentId}'. Register it first.`,
        );
      }
      if (existing !== undefined) {
        existing.cancel();
        await existing.task;
      }
      this.#subscriptions.set(uri, this.startSubscription(uri, agentId));
      return {};
    });
  }

  private async unsubscribe(request: UnsubscribeRequest): Promise<Record<string, never>> {
    return await this.serializeMutation(async (): Promise<Record<string, never>> => {
      const subscription: ActiveSubscription | undefined = this.#subscriptions.get(
        request.params.uri,
      );
      if (subscription !== undefined) {
        subscription.cancel();
        await subscription.task;
      }
      this.#subscriptions.delete(request.params.uri);
      return {};
    });
  }

  public registerHandlers(): void {
    this.#server.setRequestHandler(
      ListResourcesRequestSchema,
      async (): Promise<ListResourcesResult> => await this.listResources(),
    );
    this.#server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (): Promise<ListResourceTemplatesResult> => ({
        resourceTemplates: [
          {
            description:
              "An end-to-end encrypted inbox that decrypts only inside this local proxy.",
            mimeType: "application/json",
            name: "Encrypted agent inbox",
            uriTemplate: `${INBOX_PREFIX}{agent_id}`,
          },
        ],
      }),
    );
    this.#server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: ReadResourceRequest): Promise<ReadResourceResult> =>
        await this.readResource(request),
    );
    this.#server.setRequestHandler(
      SubscribeRequestSchema,
      async (request: SubscribeRequest): Promise<Record<string, never>> =>
        await this.subscribe(request),
    );
    this.#server.setRequestHandler(
      UnsubscribeRequestSchema,
      async (request: UnsubscribeRequest): Promise<Record<string, never>> =>
        await this.unsubscribe(request),
    );
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#mutationQueue;
    const active: readonly ActiveSubscription[] = Array.from(this.#subscriptions.values());
    active.forEach((subscription: ActiveSubscription): void => {
      subscription.cancel();
    });
    this.#subscriptions.clear();
    const results: readonly PromiseSettledResult<void>[] = await Promise.allSettled(
      active.map((subscription: ActiveSubscription): Promise<void> => subscription.task),
    );
    results.forEach((result: PromiseSettledResult<void>): void => {
      if (result.status === "rejected") {
        logSafeError("Murmur encrypted inbox subscription shutdown failed", result.reason);
      }
    });
  }
}
