import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import type { AgentIdentity, JsonRpcExchange } from "./hook-types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rpcResult(response: unknown): unknown {
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
  if (!response.ok) throw new Error(`Murmur HTTP ${response.status}: ${content.slice(0, 300)}`);
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

export function requestHeaders(
  identity: AgentIdentity,
  token: string,
  sessionId: string | null,
): Headers {
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

export async function postJsonRpc(options: {
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

export function remainingTimeoutMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}
