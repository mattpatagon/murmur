import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  CallToolResultSchema,
  type ElicitResult,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AgentClientName } from "../../src/domain/client-provenance.js";
import { readApprovedMcpResponse } from "./approved-mcp-response.js";

const UnknownRecordSchema: z.ZodRecord<z.ZodString, z.ZodUnknown> = z.record(
  z.string(),
  z.unknown(),
);

export type ProductionHarness = {
  readonly clientName: AgentClientName;
  readonly repositoryName: string;
  readonly sessionId: string;
  readonly token: string;
  readonly url: URL;
};

class AuthenticationCapacityError extends Error {}

export function requiredEnvironment(name: string): string {
  const value: string | undefined = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt: number = 1; attempt <= 6; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (!(error instanceof AuthenticationCapacityError) || attempt === 6) throw error;
      await Bun.sleep(attempt * 250);
    }
  }
  throw lastError;
}

function headers(
  token: string,
  sessionId: string | null,
  clientName: AgentClientName,
  repositoryName: string,
): Headers {
  const result: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "production-canary",
    "X-Murmur-Client": clientName,
    "X-Murmur-Repository": repositoryName,
  });
  if (sessionId !== null) {
    result.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
    result.set("Mcp-Session-Id", sessionId);
  }
  return result;
}

async function responsePayload(response: Response): Promise<unknown> {
  const body: string = await response.text();
  if (!response.ok) {
    let capacityReached: boolean = false;
    try {
      const parsed: Record<string, unknown> = recordValue(JSON.parse(body), "error response");
      capacityReached =
        response.status === 503 && parsed["error"] === "Authentication capacity reached";
    } catch (_error: unknown) {
      capacityReached = false;
    }
    if (capacityReached) throw new AuthenticationCapacityError("Authentication capacity reached");
    throw new Error(`Murmur returned HTTP ${String(response.status)}`);
  }
  if (body === "") return null;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data: string | undefined = body
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "))
    .at(-1);
  if (data === undefined) throw new Error("Murmur returned an empty MCP event stream");
  return JSON.parse(data.slice("data: ".length));
}

async function post(
  url: URL,
  token: string,
  sessionId: string | null,
  clientName: AgentClientName,
  repositoryName: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: headers(token, sessionId, clientName, repositoryName),
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
}

function envelopeResult(value: unknown): unknown {
  const envelope: Record<string, unknown> = recordValue(value, "JSON-RPC envelope");
  if (envelope["error"] !== undefined) throw new Error("Murmur returned a JSON-RPC error");
  assertCondition(envelope["result"] !== undefined, "Murmur JSON-RPC response omitted its result");
  return envelope["result"];
}

export async function connectProductionHarness(
  url: URL,
  token: string,
  name: string,
  clientName: AgentClientName = "codex",
  repositoryName: string = "mattpatagon/murmur",
): Promise<ProductionHarness> {
  return await retry(async (): Promise<ProductionHarness> => {
    const response: Response = await post(url, token, null, clientName, repositoryName, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name, version: "1.0.0" },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    });
    envelopeResult(await responsePayload(response));
    const sessionId: string | null = response.headers.get("mcp-session-id");
    assertCondition(sessionId !== null, "Murmur initialization omitted a session ID");
    await retry(async (): Promise<void> => {
      const initialized: Response = await post(url, token, sessionId, clientName, repositoryName, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      await responsePayload(initialized);
    });
    return { clientName, repositoryName, sessionId, token, url };
  });
}

async function rpc(harness: ProductionHarness, body: Record<string, unknown>): Promise<unknown> {
  return await retry(async (): Promise<unknown> => {
    const response: Response = await post(
      harness.url,
      harness.token,
      harness.sessionId,
      harness.clientName,
      harness.repositoryName,
      body,
    );
    const params: unknown = body["params"];
    const parsed: z.ZodSafeParseResult<{
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }> = z
      .object({
        name: z.string(),
        arguments: UnknownRecordSchema,
      })
      .safeParse(params);
    const id: unknown = body["id"];
    if (
      response.ok &&
      body["method"] === "tools/call" &&
      parsed.success &&
      (typeof id === "string" || typeof id === "number")
    ) {
      return envelopeResult(
        await readApprovedMcpResponse(
          response,
          id,
          parsed.data.name,
          parsed.data.arguments,
          async (requestId: string | number, result: ElicitResult): Promise<Response> =>
            await post(
              harness.url,
              harness.token,
              harness.sessionId,
              harness.clientName,
              harness.repositoryName,
              { id: requestId, jsonrpc: "2.0", result },
            ),
        ),
      );
    }
    return envelopeResult(await responsePayload(response));
  });
}

export async function productionToolNames(harness: ProductionHarness): Promise<readonly string[]> {
  const result: ReturnType<typeof ListToolsResultSchema.parse> = ListToolsResultSchema.parse(
    await rpc(harness, { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }),
  );
  return result.tools.map((tool: (typeof result.tools)[number]): string => tool.name);
}

export async function callProductionTool(
  harness: ProductionHarness,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawResult: unknown = await rpc(harness, {
    id: randomUUID(),
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: argumentsValue, name },
  });
  const result: ReturnType<typeof CallToolResultSchema.parse> =
    CallToolResultSchema.parse(rawResult);
  if (result.isError === true) {
    throw new Error(`Murmur tool '${name}' failed: ${JSON.stringify(result.content)}`);
  }
  assertCondition(
    result.structuredContent !== undefined && result.structuredContent !== null,
    `Murmur tool '${name}' omitted structured content`,
  );
  return result.structuredContent;
}

export async function callProductionToolExpectingError(
  harness: ProductionHarness,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<string> {
  const rawResult: unknown = await rpc(harness, {
    id: randomUUID(),
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: argumentsValue, name },
  });
  const result: ReturnType<typeof CallToolResultSchema.parse> =
    CallToolResultSchema.parse(rawResult);
  assertCondition(result.isError === true, `Murmur tool '${name}' unexpectedly succeeded`);
  return JSON.stringify(result.content);
}

export function recordValue(value: unknown, name: string): Record<string, unknown> {
  const parsed: z.ZodSafeParseResult<Record<string, unknown>> =
    UnknownRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is invalid`);
  return parsed.data;
}

export function stringField(value: Record<string, unknown>, name: string): string {
  const field: unknown = value[name];
  assertCondition(typeof field === "string" && field !== "", `${name} is missing`);
  return field;
}

export async function closeProductionHarnesses(
  harnesses: readonly ProductionHarness[],
): Promise<void> {
  await Promise.allSettled(
    harnesses.map(async (harness: ProductionHarness): Promise<void> => {
      await fetch(harness.url, {
        headers: headers(
          harness.token,
          harness.sessionId,
          harness.clientName,
          harness.repositoryName,
        ),
        method: "DELETE",
      });
    }),
  );
}

export async function findTenantBySlug(
  operator: ProductionHarness,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const seenCursors: Set<string> = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const listed: Record<string, unknown> = await callProductionTool(
      operator,
      "list_tenants",
      cursor === null ? { limit: 500 } : { cursor, limit: 500 },
    );
    const tenants: unknown = listed["tenants"];
    assertCondition(Array.isArray(tenants), "Operator tenant list is invalid");
    const matching: unknown = tenants.find(
      (candidate: unknown): boolean => recordValue(candidate, "tenant")["slug"] === slug,
    );
    if (matching !== undefined) return recordValue(matching, "tenant");
    const nextCursor: unknown = listed["next_cursor"];
    if (nextCursor === null) return null;
    assertCondition(
      typeof nextCursor === "string" && nextCursor !== "",
      "Tenant cursor is invalid",
    );
    assertCondition(!seenCursors.has(nextCursor), "Tenant pagination cursor repeated");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function ensureTenantSuspended(
  operator: ProductionHarness,
  tenantId: string,
  tenantSlug: string,
): Promise<void> {
  for (let attempt: number = 1; attempt <= 3; attempt += 1) {
    await callProductionTool(operator, "suspend_tenant", { tenant_id: tenantId }).catch(
      (): undefined => undefined,
    );
    const tenant: Record<string, unknown> | null = await findTenantBySlug(
      operator,
      tenantSlug,
    ).catch((): null => null);
    if (tenant !== null && tenant["tenant_id"] === tenantId && tenant["status"] === "suspended") {
      return;
    }
    if (attempt < 3) await Bun.sleep(attempt * 250);
  }
  throw new Error(`Canary cleanup failed for ${tenantSlug} (${tenantId})`);
}

async function credentialIsRevoked(url: URL, token: string): Promise<boolean> {
  return await retry(async (): Promise<boolean> => {
    const response: Response = await post(url, token, null, "codex", "mattpatagon/murmur", {
      id: randomUUID(),
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "live-revocation-probe", version: "1.0.0" },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    });
    if (response.status === 401) return true;
    await responsePayload(response);
    const sessionId: string | null = response.headers.get("mcp-session-id");
    if (sessionId !== null) {
      await fetch(url, {
        headers: headers(token, sessionId, "codex", "mattpatagon/murmur"),
        method: "DELETE",
      }).catch((): undefined => undefined);
    }
    return false;
  });
}

export async function ensureTokenRevoked(harness: ProductionHarness, keyId: string): Promise<void> {
  for (let attempt: number = 1; attempt <= 3; attempt += 1) {
    await callProductionTool(harness, "revoke_access_token", { key_id: keyId }).catch(
      (): undefined => undefined,
    );
    const revoked: boolean = await credentialIsRevoked(harness.url, harness.token).catch(
      (): boolean => false,
    );
    if (revoked) return;
    if (attempt < 3) await Bun.sleep(attempt * 250);
  }
  throw new Error(`Temporary founding credential cleanup failed for key ${keyId}`);
}
