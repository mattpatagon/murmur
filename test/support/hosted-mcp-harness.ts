import { expect } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

import type { BootstrapCredential } from "../../src/hosted/bootstrap-secret.js";
import { type PostgresTlsConfiguration, postgresSslOptions } from "../../src/postgres-tls.js";

export const databaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];
export const adminDatabaseUrl: string | undefined = process.env["MURMUR_TEST_ADMIN_DATABASE_URL"];
export const bootstrapLegacyToken: string | undefined =
  process.env["MURMUR_TEST_BOOTSTRAP_LEGACY_TOKEN"];
export const existingOperatorToken: string | undefined = process.env["MURMUR_TEST_OPERATOR_TOKEN"];
export const testTlsConfiguration: PostgresTlsConfiguration =
  process.env["MURMUR_TEST_DATABASE_TLS_INSECURE"] === "1"
    ? { mode: "insecure" }
    : { mode: "verify-system" };
const JsonRpcEnvelopeSchema: z.ZodObject<{
  result: z.ZodType<unknown>;
}> = z.object({ result: z.unknown() });
const ToolNamesEnvelopeSchema: z.ZodObject<{
  result: z.ZodObject<{
    tools: z.ZodArray<z.ZodObject<{ name: z.ZodString }>>;
  }>;
}> = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});
const ResourceUpdatedEnvelopeSchema: z.ZodType<{
  readonly method: "notifications/resources/updated";
  readonly params: { readonly uri: string };
}> = z.object({
  method: z.literal("notifications/resources/updated"),
  params: z.object({ uri: z.string() }),
});

export function headers(token: string, sessionId: string | null = null): Headers {
  const value: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "feature/hosted-isolation",
    "X-Murmur-Client": "codex",
    "X-Murmur-Repository": "mattpatagon/murmur",
  });
  if (sessionId !== null) {
    value.set("Mcp-Session-Id", sessionId);
    value.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return value;
}

export function operatorSecret(): string {
  return `mur_op_${randomBytes(6).toString("base64url")}_${randomBytes(32).toString("base64url")}`;
}

async function payload(response: Response): Promise<unknown> {
  const body: string = await response.text();
  const contentType: string = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  const data: string | undefined = body
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "))
    .at(-1);
  if (data === undefined) throw new Error("Hosted MCP response did not include a data event");
  return JSON.parse(data.slice("data: ".length));
}

export async function post(
  url: URL,
  token: string,
  sessionId: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: headers(token, sessionId),
    method: "POST",
  });
}

export async function initialize(url: URL, token: string, clientName: string): Promise<string> {
  const response: Response = await post(url, token, null, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  });
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await payload(response));
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Hosted MCP initialize omitted its session ID");
  const initialized: Response = await post(url, token, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  expect(initialized.status).toBe(202);
  return sessionId;
}

export async function toolNames(
  url: URL,
  token: string,
  sessionId: string,
): Promise<readonly string[]> {
  const response: Response = await post(url, token, sessionId, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  expect(response.status).toBe(200);
  return ToolNamesEnvelopeSchema.parse(await payload(response)).result.tools.map(
    (tool: { readonly name: string }): string => tool.name,
  );
}

export async function callTool<T>(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  name: string,
  argumentsValue: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: argumentsValue, name },
  });
  expect(response.status).toBe(200);
  const envelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
    await payload(response),
  );
  const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(envelope.result);
  if (result.isError === true) {
    throw new Error(`Hosted MCP tool '${name}' failed: ${JSON.stringify(result.content)}`);
  }
  return schema.parse(result.structuredContent);
}

export async function callToolExpectingError(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<string> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: argumentsValue, name },
  });
  expect(response.status).toBe(200);
  const envelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
    await payload(response),
  );
  const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(envelope.result);
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}

export async function subscribeInbox(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  uri: string,
): Promise<void> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "resources/subscribe",
    params: { uri },
  });
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await payload(response));
}

export async function subscribeInboxExpectingError(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  uri: string,
): Promise<string> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "resources/subscribe",
    params: { uri },
  });
  expect(response.status).toBe(200);
  return JSON.stringify(await payload(response));
}

export async function nextResourceUpdate(response: Response): Promise<string> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) throw new Error("Hosted subscription response omitted its body");
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder: TextDecoder = new TextDecoder();
  let buffered: string = "";
  while (true) {
    const result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
      await reader.read();
    if (result.done) throw new Error("Hosted subscription closed before an update");
    buffered += decoder.decode(result.value, { stream: true });
    const lines: string[] = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const parsed: z.ZodSafeParseResult<z.infer<typeof ResourceUpdatedEnvelopeSchema>> =
        ResourceUpdatedEnvelopeSchema.safeParse(JSON.parse(line.slice("data: ".length)));
      if (parsed.success) return parsed.data.params.uri;
    }
  }
}

export async function configureBootstrap(
  configuredAdminDatabaseUrl: string,
  credential: BootstrapCredential,
): Promise<void> {
  const database: Sql = postgres(configuredAdminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
  });
  try {
    await database`
      SELECT murmur.configure_operator_bootstrap(
        ${randomUUID()}::uuid,
        ${credential.keyId},
        ${credential.hash}
      )
    `;
  } finally {
    await database.end({ timeout: 5 });
  }
}

export async function finalizeTenantContract(configuredAdminDatabaseUrl: string): Promise<boolean> {
  const database: Sql = postgres(configuredAdminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
  });
  try {
    const rows: { readonly changed: boolean }[] = await database`
      SELECT murmur.finalize_tenant_contract() AS changed
    `;
    const row: { readonly changed: boolean } | undefined = rows[0];
    if (row === undefined) throw new Error("Tenant contract finalization returned no row");
    return row.changed;
  } finally {
    await database.end({ timeout: 5 });
  }
}
