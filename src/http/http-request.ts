import { AgentClient, BranchName, RepositoryName } from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import { parseBoundedJsonText } from "./bounded-json.js";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "./http-capacity.js";

const BRANCH_HEADER: string = "x-murmur-branch";
const CLIENT_HEADER: string = "x-murmur-client";
const REPOSITORY_HEADER: string = "x-murmur-repository";
const SAFE_MCP_NAME: RegExp = /^[A-Za-z][A-Za-z0-9_./-]{0,127}$/u;

export type McpRequestMetadata = {
  readonly method: string | null;
  readonly tool: string | null;
};

export class RequestBodyTooLargeError extends Error {
  public constructor(limit: number) {
    super(`The MCP request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends Error {
  public constructor() {
    super("Request body deadline exceeded");
    this.name = "RequestBodyTimeoutError";
  }
}

export function bearerToken(request: Request): string | null {
  const authorization: string | null = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token: string = authorization.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" }, status });
}

export function authenticationCapacityResponse(): Response {
  return Response.json(
    { error: "Authentication capacity reached" },
    { headers: { "cache-control": "no-store", "retry-after": "1" }, status: 503 },
  );
}

export function streamCapacityResponse(): Response {
  return Response.json(
    { error: "MCP stream capacity reached" },
    { headers: { "cache-control": "no-store", "retry-after": "1" }, status: 503 },
  );
}

export function unauthorizedResponse(resourceMetadataUrl: string | null = null): Response {
  const challenge: string =
    resourceMetadataUrl === null
      ? 'Bearer realm="murmur"'
      : `Bearer realm="murmur", resource_metadata="${resourceMetadataUrl}", scope="murmur"`;
  return new Response(null, {
    headers: { "cache-control": "no-store", "www-authenticate": challenge },
    status: 401,
  });
}

export function originIsAllowed(request: Request, allowedOrigins: ReadonlySet<string>): boolean {
  const origin: string | null = request.headers.get("origin");
  return origin === null || allowedOrigins.has(origin);
}

export function repositoryFromRequest(request: Request): RepositoryName | null {
  const configured: string | null = request.headers.get(REPOSITORY_HEADER);
  return configured === null || configured.trim() === "" ? null : RepositoryName.parse(configured);
}

export function branchFromRequest(request: Request): BranchName | null {
  const configured: string | null = request.headers.get(BRANCH_HEADER);
  return configured === null || configured.trim() === "" ? null : BranchName.parse(configured);
}

export function clientFromRequest(request: Request): AgentClient | null {
  const configured: string | null = request.headers.get(CLIENT_HEADER);
  return configured === null || configured.trim() === ""
    ? null
    : AgentClient.parse(configured.trim().toLowerCase());
}

export function requestSessionId(request: Request): string | null {
  const value: string | null = request.headers.get("mcp-session-id");
  return value === null || value.trim() === "" ? null : value;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMcpName(value: unknown): string | null {
  return typeof value === "string" && SAFE_MCP_NAME.test(value) ? value : null;
}

export function mcpRequestMetadata(body: unknown): McpRequestMetadata {
  if (!isObject(body)) return { method: null, tool: null };
  const method: string | null = safeMcpName(body["method"]);
  if (method !== "tools/call") return { method, tool: null };
  const params: unknown = body["params"];
  return {
    method,
    tool: isObject(params) ? safeMcpName(params["name"]) : null,
  };
}

async function consumeBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  deadline: number,
  time: TimeSource,
): Promise<Uint8Array> {
  let buffer: Uint8Array = new Uint8Array(Math.min(maxBytes, 16_384));
  let total: number = 0;
  while (true) {
    if (time.now() >= deadline) throw new RequestBodyTimeoutError();
    const result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
      await reader.read();
    if (time.now() >= deadline) throw new RequestBodyTimeoutError();
    if (result.done) return buffer.subarray(0, total);
    const nextTotal: number = total + result.value.byteLength;
    if (nextTotal > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
    if (nextTotal > buffer.byteLength) {
      const grown: Uint8Array = new Uint8Array(
        Math.min(maxBytes, Math.max(nextTotal, buffer.byteLength * 2)),
      );
      grown.set(buffer.subarray(0, total));
      buffer = grown;
    }
    buffer.set(result.value, total);
    total = nextTotal;
  }
}

export async function requestBodyBytes(
  request: Request,
  maxBytes: number,
  time: TimeSource = SYSTEM_TIME_SOURCE,
): Promise<Uint8Array> {
  const declaredLength: string | null = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) return new Uint8Array();
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const deadline: number = time.now() + 10_000;
  let cancelDeadline: () => void = (): void => {};
  const expired: Promise<never> = new Promise<never>(
    (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
      cancelDeadline = time.schedule(10_000, (): void => reject(new RequestBodyTimeoutError()));
    },
  );
  try {
    return await Promise.race([consumeBody(reader, maxBytes, deadline, time), expired]);
  } catch (error: unknown) {
    // An unresponsive producer must not extend the absolute read deadline during cleanup.
    void reader.cancel().catch((cancelError: unknown): void => {
      logSafeError("Murmur request body cancellation failed", cancelError);
    });
    throw error;
  } finally {
    cancelDeadline();
    reader.releaseLock();
  }
}

export async function parseRequestBody(
  request: Request,
  maxBytes: number,
  time: TimeSource = SYSTEM_TIME_SOURCE,
): Promise<unknown> {
  try {
    const bytes: Uint8Array = await requestBodyBytes(request, maxBytes, time);
    return parseBoundedJsonText(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError || error instanceof RequestBodyTimeoutError) {
      throw error;
    }
    throw new Error("The MCP request body must be valid JSON", { cause: error });
  }
}
