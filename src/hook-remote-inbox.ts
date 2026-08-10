import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { type InboxOutput, InboxOutputSchema } from "./domain/contracts.js";
import { type GetInboxSummaryOutput, GetInboxSummaryOutputSchema } from "./e2ee/wire-tools.js";
import type { AgentIdentity, InboxSummary } from "./hook.js";

type JsonRpcExchange = {
  readonly body: unknown;
  readonly response: Response;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcResult(response: unknown): unknown {
  if (!isRecord(response)) throw new Error("Murmur returned an invalid JSON-RPC response");
  if (response["error"] !== undefined) {
    const error: unknown = response["error"];
    const message: string =
      isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : "Murmur JSON-RPC request failed";
    throw new Error(message);
  }
  if (!("result" in response)) throw new Error("Murmur JSON-RPC response has no result");
  return response["result"];
}

async function responseBody(response: Response): Promise<unknown> {
  const content: string = await response.text();
  if (!response.ok) {
    throw new Error(`Murmur HTTP ${response.status}: ${content.slice(0, 300)}`);
  }
  if (content.trim() === "") return null;
  const contentType: string = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(content);
  const data: string[] = [];
  for (const line of content.split(/\r?\n/gu)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  const lastEvent: string | undefined = data.at(-1);
  if (lastEvent === undefined) throw new Error("Murmur returned an empty event stream");
  return JSON.parse(lastEvent);
}

function requestHeaders(identity: AgentIdentity, token: string, sessionId: string | null): Headers {
  const headers: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
    "X-Murmur-Client": identity.client,
  });
  if (identity.branch !== null) headers.set("X-Murmur-Branch", identity.branch);
  if (identity.repository !== null) headers.set("X-Murmur-Repository", identity.repository);
  if (sessionId !== null) headers.set("Mcp-Session-Id", sessionId);
  return headers;
}

async function postJsonRpc(options: {
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly timeoutMs: number;
  readonly url: string;
}): Promise<JsonRpcExchange> {
  const response: Response = await fetch(options.url, {
    body: JSON.stringify(options.body),
    headers: options.headers,
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  return { body: await responseBody(response), response };
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function registrationRequest(identity: AgentIdentity): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "register_agent",
      arguments: {
        agent_id: identity.agentId,
        display_name: identity.displayName,
        metadata: {
          client: identity.client,
          machine: identity.machine,
          ...(identity.repository === null ? {} : { repository: identity.repository }),
          workspace: identity.workspace,
        },
      },
    },
  };
}

function inboxRequest(
  identity: AgentIdentity,
  afterSequence: number,
  e2ee: boolean,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: e2ee
      ? { name: "get_inbox_summary", arguments: { agent_id: identity.agentId } }
      : {
          name: "get_messages",
          arguments: {
            after_sequence: afterSequence,
            agent_id: identity.agentId,
            limit: 100,
            unread_only: true,
          },
        },
  };
}

function parseInboxSummary(
  result: unknown,
  identity: AgentIdentity,
  afterSequence: number,
  e2ee: boolean,
): InboxSummary {
  if (!isRecord(result)) throw new Error("Murmur returned an invalid tool result");
  if (e2ee) {
    const summary: GetInboxSummaryOutput = GetInboxSummaryOutputSchema.parse(
      result["structuredContent"],
    );
    if (summary.agent_id !== identity.agentId) {
      throw new Error("Murmur returned an inconsistent inbox summary identity");
    }
    return {
      inboxVersion: summary.inbox_version,
      messageCount: summary.unread_count,
      senderIds: [],
    };
  }
  const inbox: InboxOutput = InboxOutputSchema.parse(result["structuredContent"]);
  if (inbox.agent_id !== identity.agentId) {
    throw new Error("Murmur returned an inconsistent inbox identity");
  }
  const lastMessage: InboxOutput["messages"][number] | undefined = inbox.messages.at(-1);
  return {
    inboxVersion: lastMessage === undefined ? afterSequence : lastMessage.sequence,
    messageCount: inbox.messages.length,
    senderIds: [
      ...new Set(
        inbox.messages.map((message: InboxOutput["messages"][number]): string => message.sender_id),
      ),
    ].slice(0, 5),
  };
}

export async function checkRemoteInbox(
  identity: AgentIdentity,
  options: {
    readonly afterSequence?: number | undefined;
    readonly e2ee?: boolean | undefined;
    readonly token: string;
    readonly timeoutMs: number;
    readonly url: string;
  },
): Promise<InboxSummary> {
  const afterSequence: number = options.afterSequence ?? 0;
  const e2ee: boolean = options.e2ee === true;
  const deadline: number = Date.now() + options.timeoutMs;
  const initialize: JsonRpcExchange = await postJsonRpc({
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "murmur-hook", version: "0.1.0" },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    },
    headers: requestHeaders(identity, options.token, null),
    timeoutMs: remainingTimeoutMs(deadline),
    url: options.url,
  });
  rpcResult(initialize.body);
  const sessionId: string | null = initialize.response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Murmur did not create an MCP session");
  const headers: Headers = requestHeaders(identity, options.token, sessionId);
  try {
    await postJsonRpc({
      body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      headers,
      timeoutMs: remainingTimeoutMs(deadline),
      url: options.url,
    });
    const registration: JsonRpcExchange = await postJsonRpc({
      body: registrationRequest(identity),
      headers,
      timeoutMs: remainingTimeoutMs(deadline),
      url: options.url,
    });
    rpcResult(registration.body);
    const inboxResponse: JsonRpcExchange = await postJsonRpc({
      body: inboxRequest(identity, afterSequence, e2ee),
      headers,
      timeoutMs: remainingTimeoutMs(deadline),
      url: options.url,
    });
    return parseInboxSummary(rpcResult(inboxResponse.body), identity, afterSequence, e2ee);
  } finally {
    await fetch(options.url, {
      headers,
      method: "DELETE",
      signal: AbortSignal.timeout(remainingTimeoutMs(deadline)),
    }).catch((): void => undefined);
  }
}
