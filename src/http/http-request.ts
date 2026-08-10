import { AgentClient, BranchName, RepositoryName } from "../domain/value-objects.js";

const BRANCH_HEADER: string = "x-murmur-branch";
const CLIENT_HEADER: string = "x-murmur-client";
const REPOSITORY_HEADER: string = "x-murmur-repository";

export class RequestBodyTooLargeError extends Error {
  public constructor(limit: number) {
    super(`The MCP request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
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

export function unauthorizedResponse(): Response {
  return new Response(null, {
    headers: { "cache-control": "no-store", "www-authenticate": 'Bearer realm="murmur"' },
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

async function requestBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength: string | null = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) return new Uint8Array();
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  try {
    while (true) {
      const result: { readonly done: boolean; readonly value?: Uint8Array | undefined } =
        await reader.read();
      if (result.done) break;
      const value: Uint8Array | undefined = result.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error: unknown) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  chunks.forEach((chunk: Uint8Array): void => {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return merged;
}

export async function parseRequestBody(request: Request, maxBytes: number): Promise<unknown> {
  try {
    const bytes: Uint8Array = await requestBodyBytes(request, maxBytes);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw new Error("The MCP request body must be valid JSON", { cause: error });
  }
}
