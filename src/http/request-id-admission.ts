import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  JSONRPCRequestSchema,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

import { preflightHttpRequest } from "../mcp/request-processing-admission.js";
import {
  currentRequestIdClaim,
  type IncomingRequestId,
  RequestIdClaim,
  withRequestIdClaim,
} from "../request-id-admission.js";
import { logSafeError } from "../safe-errors.js";
import { responseWithFinish } from "./response-lifecycle.js";

export const MAX_TRACKED_REQUEST_IDS: number = 256;
export const MAX_SESSION_REQUEST_IDS: number = 64;
export const MAX_REQUEST_ID_LENGTH: number = 1024;
type Transport = WebStandardStreamableHTTPServerTransport;
type SendOptions = Parameters<Transport["send"]>[1];

function rejection(status: number, message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: status === 503 ? -32003 : -32600,
        message,
        ...(status === 503 ? { data: { retryable: true, retry_after_ms: 1000 } } : {}),
      },
    },
    {
      status,
      headers: { "cache-control": "no-store", ...(status === 503 ? { "retry-after": "1" } : {}) },
    },
  );
}

export class HttpRequestIdAdmission {
  private readonly retired: WeakSet<Transport> = new WeakSet<Transport>();
  private readonly sessions: WeakMap<Transport, Map<IncomingRequestId, RequestIdClaim>> =
    new WeakMap<Transport, Map<IncomingRequestId, RequestIdClaim>>();
  private active: number = 0;

  public get activeClaims(): number {
    return this.active;
  }

  private retire(transport: Transport): void {
    if (this.retired.has(transport)) return;
    this.retired.add(transport);
    // The SDK retains skipped-response correlations. Remove the affected session through its
    // public lifecycle instead of retaining unbounded cancelled-ID history in a live transport.
    void transport.close().catch((error: unknown): void => {
      logSafeError("Murmur cancelled-request session shutdown failed", error);
    });
  }

  private session(transport: Transport): Map<IncomingRequestId, RequestIdClaim> {
    const existing: Map<IncomingRequestId, RequestIdClaim> | undefined =
      this.sessions.get(transport);
    if (existing !== undefined) return existing;
    const claims: Map<IncomingRequestId, RequestIdClaim> = new Map<
      IncomingRequestId,
      RequestIdClaim
    >();
    const onmessage: Transport["onmessage"] = transport.onmessage;
    if (onmessage === undefined)
      throw new Error("Connect the MCP server before request-ID admission");
    transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo): void => {
      const claim: RequestIdClaim | undefined = isJSONRPCRequest(message)
        ? claims.get(message.id)
        : undefined;
      if (claim !== undefined) claim.markDispatched();
      withRequestIdClaim(claim, (): void => onmessage(message, extra));
    };
    const send: Transport["send"] = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage, options?: SendOptions): Promise<void> => {
      if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) {
        return await send(message, options);
      }
      const claim: RequestIdClaim | undefined = currentRequestIdClaim();
      const owner: RequestIdClaim | undefined =
        message.id === null || message.id === undefined ? undefined : claims.get(message.id);
      if (claim !== owner || (claim !== undefined && claim.id !== message.id)) {
        throw new Error("Invalid MCP request-ID response ownership");
      }
      const finish: () => void = claim === undefined ? (): void => {} : claim.startSend();
      try {
        await send(message, options);
      } finally {
        finish();
      }
    };
    this.sessions.set(transport, claims);
    return claims;
  }

  public async handle(
    transport: Transport,
    request: Request,
    parsedBody?: unknown,
  ): Promise<Response> {
    if (this.retired.has(transport))
      return rejection(404, "MCP session ended after cancellation; initialize a new session.");
    if (request.method !== "POST") return await transport.handleRequest(request);
    if (parsedBody === undefined) return rejection(400, "MCP request body is required.");
    if (Array.isArray(parsedBody))
      return rejection(
        400,
        "MCP HTTP requests must contain one JSON-RPC message; batches are not supported.",
      );
    const messages: readonly unknown[] = [parsedBody];
    const ids: Set<IncomingRequestId> = new Set<IncomingRequestId>();
    const requests: JSONRPCRequest[] = [];
    for (const message of messages) {
      const parsed: ReturnType<typeof JSONRPCRequestSchema.safeParse> =
        JSONRPCRequestSchema.safeParse(message);
      if (!parsed.success) continue;
      const id: IncomingRequestId = parsed.data.id;
      if (typeof id === "string" && id.length > MAX_REQUEST_ID_LENGTH) {
        return rejection(400, "MCP request ID exceeds 1024 UTF-16 units.");
      }
      ids.add(id);
      requests.push(parsed.data);
    }
    const session: Map<IncomingRequestId, RequestIdClaim> = this.session(transport);
    for (const id of ids) {
      if (session.has(id)) return rejection(409, "MCP request ID is already active.");
    }
    if (
      session.size + ids.size > MAX_SESSION_REQUEST_IDS ||
      this.active + ids.size > MAX_TRACKED_REQUEST_IDS
    ) {
      return rejection(503, "MCP request-ID admission capacity reached; retry later.");
    }
    for (const message of requests) {
      if (!preflightHttpRequest(transport, message))
        return rejection(400, "MCP request parameters are invalid or unsupported.");
    }
    const admitted: RequestIdClaim[] = [];
    for (const id of ids) {
      const claim: RequestIdClaim = new RequestIdClaim(id, (abortedBeforeSend: boolean): void => {
        if (session.get(id) !== claim) return;
        session.delete(id);
        this.active -= 1;
        if (abortedBeforeSend) this.retire(transport);
      });
      session.set(id, claim);
      this.active += 1;
      admitted.push(claim);
    }
    try {
      const response: Response = await transport.handleRequest(request, { parsedBody });
      for (const claim of admitted) claim.finishDispatch();
      return responseWithFinish(response, (): void => {
        for (const claim of admitted) claim.finishResponse();
      });
    } catch (error: unknown) {
      for (const claim of admitted) {
        claim.finishDispatch();
        claim.finishResponse();
      }
      throw error;
    }
  }
}
