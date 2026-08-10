import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { InboxOutputSchema, type InboxOutput } from "./domain/contracts.js";
import { type RegisterAgentOutput, RegisterAgentOutputSchema } from "./domain/agent-contracts.js";
import { type ListNoticesOutput, ListNoticesOutputSchema } from "./domain/notice-contracts.js";
import type { AgentIdentity, InboxSummary, JsonRpcExchange } from "./hook-types.js";
import {
  isRecord,
  postJsonRpc,
  remainingTimeoutMs,
  requestHeaders,
  rpcResult,
} from "./hook-protocol.js";

export async function checkRemoteInbox(
  identity: AgentIdentity,
  options: {
    readonly afterSequence?: number | undefined;
    readonly includeNotices?: boolean | undefined;
    readonly sessionKey?: string | undefined;
    readonly token: string;
    readonly timeoutMs: number;
    readonly url: string;
  },
): Promise<InboxSummary> {
  const afterSequence: number = options.afterSequence ?? 0;
  const sessionKey: string = options.sessionKey ?? "default";
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
      body: {
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
            session_key: sessionKey,
          },
        },
      },
      headers,
      timeoutMs: remainingTimeoutMs(deadline),
      url: options.url,
    });
    const registrationResult: unknown = rpcResult(registration.body);
    if (!isRecord(registrationResult)) throw new Error("Murmur returned an invalid tool result");
    const registered: RegisterAgentOutput = RegisterAgentOutputSchema.parse(
      registrationResult["structuredContent"],
    );
    const inboxResponse: JsonRpcExchange = await postJsonRpc({
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_messages",
          arguments: {
            after_sequence: afterSequence,
            agent_id: identity.agentId,
            limit: 100,
            session_key: sessionKey,
            unread_only: true,
          },
        },
      },
      headers,
      timeoutMs: remainingTimeoutMs(deadline),
      url: options.url,
    });
    const toolResult: unknown = rpcResult(inboxResponse.body);
    if (!isRecord(toolResult)) throw new Error("Murmur returned an invalid tool result");
    const inbox: InboxOutput = InboxOutputSchema.parse(toolResult["structuredContent"]);
    const noticeCount: number = await openNoticeCount(identity, options, headers, deadline);
    const lastMessage: InboxOutput["messages"][number] | undefined = inbox.messages.at(-1);
    return {
      agentGeneration: registered.agent.generation,
      inboxVersion: lastMessage === undefined ? afterSequence : lastMessage.sequence,
      messageCount: inbox.messages.length,
      ...(options.includeNotices === true ? { noticeCount } : {}),
      senderIds: [
        ...new Set(
          inbox.messages.map(
            (message: InboxOutput["messages"][number]): string => message.sender_id,
          ),
        ),
      ].slice(0, 5),
    };
  } finally {
    await closeRemoteSession(options.url, headers, deadline);
  }
}

async function openNoticeCount(
  identity: AgentIdentity,
  options: {
    readonly includeNotices?: boolean | undefined;
    readonly sessionKey?: string | undefined;
    readonly url: string;
  },
  headers: Headers,
  deadline: number,
): Promise<number> {
  if (options.includeNotices !== true || identity.repository === null) return 0;
  const response: JsonRpcExchange = await postJsonRpc({
    body: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "list_notices",
        arguments: {
          actor_id: identity.agentId,
          limit: 100,
          repository: identity.repository,
          session_key: options.sessionKey ?? "default",
          state: "open",
        },
      },
    },
    headers,
    timeoutMs: remainingTimeoutMs(deadline),
    url: options.url,
  });
  const result: unknown = rpcResult(response.body);
  if (!isRecord(result)) throw new Error("Murmur returned an invalid tool result");
  const notices: ListNoticesOutput = ListNoticesOutputSchema.parse(result["structuredContent"]);
  return notices.notices.length;
}

async function closeRemoteSession(url: string, headers: Headers, deadline: number): Promise<void> {
  await fetch(url, {
    headers,
    method: "DELETE",
    signal: AbortSignal.timeout(remainingTimeoutMs(deadline)),
  }).catch((): void => undefined);
}

export async function endRemoteAgentSession(
  identity: AgentIdentity,
  options: {
    readonly eventName: "SessionEnd" | "Stop";
    readonly expectedGeneration: number;
    readonly sessionKey: string;
    readonly token: string;
    readonly timeoutMs: number;
    readonly url: string;
  },
): Promise<void> {
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
    const response: JsonRpcExchange = await postJsonRpc({
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "end_session",
          arguments: {
            agent_id: identity.agentId,
            end_default_session: true,
            expected_generation: options.expectedGeneration,
            reason: options.eventName === "Stop" ? "stop" : "session_end",
            session_key: options.sessionKey,
          },
        },
      },
      headers,
      timeoutMs: remainingTimeoutMs(deadline),
      url: options.url,
    });
    rpcResult(response.body);
  } finally {
    await closeRemoteSession(options.url, headers, deadline);
  }
}
