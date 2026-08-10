#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  assertCondition as assert,
  callProductionTool as call,
  callProductionToolExpectingError as callExpectingError,
  closeProductionHarnesses as closeAll,
  connectProductionHarness as connect,
  ensureTenantSuspended,
  ensureTokenRevoked,
  findTenantBySlug,
  type ProductionHarness as Harness,
  recordValue as record,
  requiredEnvironment,
  stringField,
  productionToolNames as toolNames,
} from "./lib/production-hosted-harness.js";

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
