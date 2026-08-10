#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  CallToolResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";

const UnknownRecordSchema: z.ZodRecord<z.ZodString, z.ZodUnknown> = z.record(
  z.string(),
  z.unknown(),
);

type Harness = {
  readonly clientName: "claude" | "codex";
  readonly sessionId: string;
  readonly token: string;
  readonly url: URL;
};

class AuthenticationCapacityError extends Error {}

function requiredEnvironment(name: string): string {
  const value: string | undefined = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
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

function headers(token: string, sessionId: string | null, clientName: "claude" | "codex"): Headers {
  const result: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "production-canary",
    "X-Murmur-Client": clientName,
    "X-Murmur-Repository": "mattpatagon/murmur",
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
      const parsed: Record<string, unknown> = record(JSON.parse(body), "error response");
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
  clientName: "claude" | "codex",
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: headers(token, sessionId, clientName),
    method: "POST",
  });
}

function envelopeResult(value: unknown): unknown {
  const envelope: Record<string, unknown> = record(value, "JSON-RPC envelope");
  if (envelope["error"] !== undefined) throw new Error("Murmur returned a JSON-RPC error");
  assert(envelope["result"] !== undefined, "Murmur JSON-RPC response omitted its result");
  return envelope["result"];
}

async function connect(
  url: URL,
  token: string,
  name: string,
  clientName: "claude" | "codex" = "codex",
): Promise<Harness> {
  return await retry(async (): Promise<Harness> => {
    const response: Response = await post(url, token, null, clientName, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name, version: "1.0.0" },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    });
    envelopeResult(await responsePayload(response));
    const sessionId: string | null = response.headers.get("mcp-session-id");
    assert(sessionId !== null, "Murmur initialization omitted a session ID");
    await retry(async (): Promise<void> => {
      const initialized: Response = await post(url, token, sessionId, clientName, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      await responsePayload(initialized);
    });
    return { clientName, sessionId, token, url };
  });
}

async function rpc(harness: Harness, body: Record<string, unknown>): Promise<unknown> {
  return await retry(async (): Promise<unknown> => {
    const response: Response = await post(
      harness.url,
      harness.token,
      harness.sessionId,
      harness.clientName,
      body,
    );
    return envelopeResult(await responsePayload(response));
  });
}

async function toolNames(harness: Harness): Promise<readonly string[]> {
  const result: ReturnType<typeof ListToolsResultSchema.parse> = ListToolsResultSchema.parse(
    await rpc(harness, { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }),
  );
  return result.tools.map((tool: (typeof result.tools)[number]): string => tool.name);
}

async function call(
  harness: Harness,
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
  assert(
    result.structuredContent !== undefined && result.structuredContent !== null,
    `Murmur tool '${name}' omitted structured content`,
  );
  return result.structuredContent;
}

async function callExpectingError(
  harness: Harness,
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
  assert(result.isError === true, `Murmur tool '${name}' unexpectedly succeeded`);
  return JSON.stringify(result.content);
}

function record(value: unknown, name: string): Record<string, unknown> {
  const parsed: z.ZodSafeParseResult<Record<string, unknown>> =
    UnknownRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is invalid`);
  return parsed.data;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field: unknown = value[name];
  assert(typeof field === "string" && field !== "", `${name} is missing`);
  return field;
}

async function closeAll(harnesses: readonly Harness[]): Promise<void> {
  await Promise.allSettled(
    harnesses.map(async (harness: Harness): Promise<void> => {
      await fetch(harness.url, {
        headers: headers(harness.token, harness.sessionId, harness.clientName),
        method: "DELETE",
      });
    }),
  );
}

async function findTenantBySlug(
  operator: Harness,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const seenCursors: Set<string> = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const listed: Record<string, unknown> = await call(
      operator,
      "list_tenants",
      cursor === null ? { limit: 500 } : { cursor, limit: 500 },
    );
    const tenants: unknown = listed["tenants"];
    assert(Array.isArray(tenants), "Operator tenant list is invalid");
    const matching: unknown = tenants.find(
      (candidate: unknown): boolean => record(candidate, "tenant")["slug"] === slug,
    );
    if (matching !== undefined) return record(matching, "tenant");
    const nextCursor: unknown = listed["next_cursor"];
    if (nextCursor === null) return null;
    assert(typeof nextCursor === "string" && nextCursor !== "", "Tenant cursor is invalid");
    assert(!seenCursors.has(nextCursor), "Tenant pagination cursor repeated");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

async function ensureTenantSuspended(
  operator: Harness,
  tenantId: string,
  tenantSlug: string,
): Promise<void> {
  for (let attempt: number = 1; attempt <= 3; attempt += 1) {
    await call(operator, "suspend_tenant", { tenant_id: tenantId }).catch(
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
    const response: Response = await post(url, token, null, "codex", {
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
        headers: headers(token, sessionId, "codex"),
        method: "DELETE",
      }).catch((): undefined => undefined);
    }
    return false;
  });
}

async function ensureTokenRevoked(harness: Harness, keyId: string): Promise<void> {
  for (let attempt: number = 1; attempt <= 3; attempt += 1) {
    await call(harness, "revoke_access_token", { key_id: keyId }).catch((): undefined => undefined);
    const revoked: boolean = await credentialIsRevoked(harness.url, harness.token).catch(
      (): boolean => false,
    );
    if (revoked) return;
    if (attempt < 3) await Bun.sleep(attempt * 250);
  }
  throw new Error(`Temporary founding credential cleanup failed for key ${keyId}`);
}

async function main(): Promise<void> {
  const url: URL = new URL(requiredEnvironment("MURMUR_LIVE_URL"));
  const operatorToken: string = requiredEnvironment("MURMUR_LIVE_OPERATOR_TOKEN");
  const unique: string = randomUUID().replaceAll("-", "").slice(0, 12);
  const tenantSlug: string = `production-canary-${unique}`;
  const senderId: string = `live-canary-sender-${unique}`;
  const receiverId: string = `live-canary-receiver-${unique}`;
  const messageContent: string = `live canary direct ${unique}`;
  const broadcastContent: string = `live canary organization broadcast ${unique}`;
  const harnesses: Harness[] = [];
  let operator: Harness | null = null;
  let founding: Harness | null = null;
  let foundingKeyId: string | null = null;
  let foundingSecret: string | null = null;
  let tenantId: string | null = null;
  let verified: boolean = false;
  let operationFailed: boolean = false;
  let operationError: unknown;
  const cleanupErrors: string[] = [];
  try {
    operator = await connect(url, operatorToken, `live-operator-${unique}`);
    harnesses.push(operator);
    const operatorTools: readonly string[] = await toolNames(operator);
    assert(operatorTools.includes("create_tenant"), "Operator cannot create tenants");
    assert(!operatorTools.includes("register_agent"), "Operator can access tenant data tools");
    assert(!operatorTools.includes("bootstrap_operator"), "Bootstrap remained available");

    const created: Record<string, unknown> = await call(operator, "create_tenant", {
      display_name: `Production canary ${unique}`,
      slug: tenantSlug,
    });
    const tenant: Record<string, unknown> = record(created["tenant"], "tenant");
    tenantId = stringField(tenant, "tenant_id");
    const initialAdminToken: Record<string, unknown> = record(created["token"], "token");
    const initialAdminSecret: string = stringField(initialAdminToken, "secret");

    const admin: Harness = await connect(url, initialAdminSecret, `live-admin-${unique}`);
    harnesses.push(admin);
    const adminTools: readonly string[] = await toolNames(admin);
    assert(adminTools.includes("create_access_token"), "Tenant admin cannot create tokens");
    assert(!adminTools.includes("create_tenant"), "Tenant admin can access operator tools");
    const forbiddenAdminOperator: string = await callExpectingError(admin, "create_tenant", {
      display_name: "Forbidden",
      slug: `forbidden-${unique}`,
    });
    assert(
      forbiddenAdminOperator.includes("Unknown tool"),
      "Admin/operator boundary leaked details",
    );

    const issuedSender: Record<string, unknown> = await call(admin, "create_access_token", {
      name: "Production canary sender",
      role: "agent",
    });
    const senderToken: Record<string, unknown> = record(issuedSender["token"], "sender token");
    const issuedReceiver: Record<string, unknown> = await call(admin, "create_access_token", {
      name: "Production canary receiver",
      role: "agent",
    });
    const receiverToken: Record<string, unknown> = record(
      issuedReceiver["token"],
      "receiver token",
    );
    const sender: Harness = await connect(
      url,
      stringField(senderToken, "secret"),
      `live-sender-${unique}`,
    );
    const receiver: Harness = await connect(
      url,
      stringField(receiverToken, "secret"),
      `live-receiver-${unique}`,
    );
    harnesses.push(sender, receiver);
    assert(
      !(await toolNames(sender)).includes("create_access_token"),
      "Agent can administer tokens",
    );

    await call(sender, "register_agent", {
      agent_id: senderId,
      display_name: "Live canary sender",
    });
    await call(receiver, "register_agent", {
      agent_id: receiverId,
      display_name: "Live canary receiver",
    });
    await call(sender, "send_message", {
      content: messageContent,
      idempotency_key: `live-direct-${unique}`,
      recipient_id: receiverId,
      sender_id: senderId,
    });
    const broadcast: Record<string, unknown> = await call(sender, "broadcast_message", {
      audience: {},
      content: broadcastContent,
      idempotency_key: `live-broadcast-${unique}`,
      sender_id: senderId,
    });
    assert(broadcast["recipient_count"] === 1, "Organization broadcast crossed tenant boundaries");
    const inbox: Record<string, unknown> = await call(receiver, "get_messages", {
      agent_id: receiverId,
      limit: 100,
      unread_only: false,
    });
    const messages: unknown = inbox["messages"];
    assert(
      Array.isArray(messages) && messages.length === 2,
      "Canary inbox has wrong message count",
    );
    const contents: string[] = messages.map((message: unknown): string =>
      stringField(record(message, "message"), "content"),
    );
    assert(
      contents.includes(messageContent) && contents.includes(broadcastContent),
      "Direct or organization message was not delivered",
    );
    await call(receiver, "mark_messages_read", {
      agent_id: receiverId,
      message_ids: messages.map((message: unknown): string =>
        stringField(record(message, "message"), "message_id"),
      ),
    });

    const mintedFounding: Record<string, unknown> = await call(
      operator,
      "mint_tenant_admin_token",
      {
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        name: `Production canary founding access ${unique}`,
        tenant_id: FOUNDING_TENANT_ID,
      },
    );
    const foundingToken: Record<string, unknown> = record(
      mintedFounding["token"],
      "founding token",
    );
    foundingKeyId = stringField(foundingToken, "key_id");
    foundingSecret = stringField(foundingToken, "secret");
    founding = await connect(url, foundingSecret, `live-founding-${unique}`);
    harnesses.push(founding);
    const foundingAgents: Record<string, unknown> = await call(founding, "list_agents", {});
    const visibleFoundingAgents: unknown = foundingAgents["agents"];
    assert(Array.isArray(visibleFoundingAgents), "Founding agent list is invalid");
    assert(
      !visibleFoundingAgents.some(
        (agent: unknown): boolean => stringField(record(agent, "agent"), "agent_id") === receiverId,
      ),
      "Founding tenant can enumerate the canary tenant",
    );
    const foundingAgent: unknown = visibleFoundingAgents[0];
    assert(foundingAgent !== undefined, "Founding tenant has no registered canary target");
    const foundingAgentId: string = stringField(record(foundingAgent, "agent"), "agent_id");
    const foundingCrossRead: string = await callExpectingError(founding, "get_messages", {
      agent_id: receiverId,
      limit: 100,
      unread_only: false,
    });
    assert(
      foundingCrossRead.includes("Unknown agent") &&
        !foundingCrossRead.includes(messageContent) &&
        !foundingCrossRead.includes(broadcastContent),
      "Cross-tenant read leaked data",
    );
    const foundingCrossSend: string = await callExpectingError(founding, "send_message", {
      content: "forbidden founding-to-canary message",
      recipient_id: receiverId,
      sender_id: foundingAgentId,
    });
    assert(foundingCrossSend.includes("Unknown agent"), "Founding tenant reached canary agent");
    const canaryCrossSend: string = await callExpectingError(sender, "send_message", {
      content: "forbidden canary-to-founding message",
      recipient_id: foundingAgentId,
      sender_id: senderId,
    });
    assert(canaryCrossSend.includes("Unknown agent"), "Canary tenant reached founding agent");

    const senderSessionId: string = sender.sessionId;
    const crossSessionResponse: Response = await fetch(url, {
      body: JSON.stringify({ id: 91, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${founding.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
        "Mcp-Session-Id": senderSessionId,
        "X-Murmur-Branch": "production-canary",
        "X-Murmur-Client": "codex",
        "X-Murmur-Repository": "mattpatagon/murmur",
      },
      method: "POST",
    });
    assert(crossSessionResponse.status === 404, "Session could be rebound across tenants");

    const suspended: Record<string, unknown> = await call(operator, "suspend_tenant", {
      tenant_id: tenantId,
    });
    assert(suspended["changed"] === true, "Canary tenant did not suspend");
    const suspendedResponse: Response = await fetch(url, {
      body: JSON.stringify({ id: 92, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${initialAdminSecret}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
        "Mcp-Session-Id": admin.sessionId,
        "X-Murmur-Branch": "production-canary",
        "X-Murmur-Client": "codex",
        "X-Murmur-Repository": "mattpatagon/murmur",
      },
      method: "POST",
    });
    assert(suspendedResponse.status === 401, "Suspended tenant credential remained active");
    const restored: Record<string, unknown> = await call(operator, "restore_tenant", {
      tenant_id: tenantId,
    });
    assert(restored["changed"] === true, "Canary tenant did not restore");
    const restoredAdmin: Harness = await connect(
      url,
      initialAdminSecret,
      `live-restored-${unique}`,
    );
    harnesses.push(restoredAdmin);
    assert(
      (await toolNames(restoredAdmin)).includes("create_access_token"),
      "Restored tenant credential did not recover",
    );

    const audit: Record<string, unknown> = await call(operator, "list_admin_audit", { limit: 100 });
    const events: unknown = audit["events"];
    assert(Array.isArray(events), "Operator audit output is invalid");
    const actions: string[] = events
      .filter(
        (event: unknown): boolean =>
          stringField(record(event, "audit event"), "target_id") === tenantId,
      )
      .map((event: unknown): string => stringField(record(event, "audit event"), "action"));
    assert(
      actions.includes("tenant.create") &&
        actions.includes("tenant.suspend") &&
        actions.includes("tenant.restore"),
      "Operator audit trail omitted canary lifecycle events",
    );

    const finalSuspension: Record<string, unknown> = await call(operator, "suspend_tenant", {
      tenant_id: tenantId,
    });
    assert(finalSuspension["changed"] === true, "Canary cleanup suspension failed");
    verified = true;
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  } finally {
    if (operator !== null && tenantId === null) {
      try {
        const recovered: Record<string, unknown> | null = await findTenantBySlug(
          operator,
          tenantSlug,
        );
        if (recovered !== null) tenantId = stringField(recovered, "tenant_id");
      } catch (_error: unknown) {
        cleanupErrors.push(`could not recover ${tenantSlug}`);
      }
    }
    if (operator !== null && tenantId !== null) {
      try {
        await ensureTenantSuspended(operator, tenantId, tenantSlug);
      } catch (_error: unknown) {
        cleanupErrors.push(`could not suspend ${tenantSlug} (${tenantId})`);
      }
    }
    if (founding === null && foundingSecret !== null) {
      try {
        founding = await connect(url, foundingSecret, `live-founding-cleanup-${unique}`);
        harnesses.push(founding);
      } catch (_error: unknown) {
        cleanupErrors.push("could not reconnect the temporary founding credential");
      }
    }
    if (founding !== null && foundingKeyId !== null) {
      try {
        await ensureTokenRevoked(founding, foundingKeyId);
      } catch (_error: unknown) {
        cleanupErrors.push(`could not revoke temporary founding credential ${foundingKeyId}`);
      }
    }
    await closeAll(harnesses);
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`Production smoke cleanup failed: ${cleanupErrors.join("; ")}`);
  }
  if (operationFailed) throw operationError;
  if (verified) {
    process.stdout.write(
      `${JSON.stringify({
        audit_verified: true,
        cross_tenant_denials: true,
        direct_message: true,
        organization_broadcast: true,
        session_binding: true,
        suspended_cleanup: true,
        tenant_id: tenantId,
        temporary_founding_credential_revoked: true,
      })}\n`,
    );
  }
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : "Live hosted verification failed");
  process.exitCode = 1;
});
