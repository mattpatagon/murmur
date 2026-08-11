#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  type ProductionE2eeCanaryResult,
  runProductionE2eeCanary,
} from "./lib/production-e2ee-canary.js";
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
  const inactiveContent: string = `live canary inactive direct ${unique}`;
  const harnesses: Harness[] = [];
  let operator: Harness | null = null;
  let founding: Harness | null = null;
  let foundingKeyId: string | null = null;
  let foundingSecret: string | null = null;
  let tenantId: string | null = null;
  let verified: boolean = false;
  let e2eeResult: ProductionE2eeCanaryResult | null = null;
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
    const receiverRegistration: Record<string, unknown> = await call(receiver, "register_agent", {
      agent_id: receiverId,
      display_name: "Live canary receiver",
    });
    const receiverAgent: Record<string, unknown> = record(receiverRegistration["agent"], "agent");
    assert(receiverAgent["generation"] === 1, "New receiver did not start at generation 1");
    const activeAgent: Record<string, unknown> = await call(receiver, "get_agent", {
      agent_id: receiverId,
    });
    assert(
      record(activeAgent["agent"], "agent")["state"] === "active",
      "Registered receiver is not active",
    );
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

    const postedNotice: Record<string, unknown> = await call(sender, "post_notice", {
      actor_id: senderId,
      content: `Production lifecycle handoff ${unique}`,
      idempotency_key: `live-notice-${unique}`,
      kind: "handoff",
    });
    const noticeId: string = stringField(record(postedNotice["notice"], "notice"), "notice_id");
    const openNotices: Record<string, unknown> = await call(receiver, "list_notices", {
      actor_id: receiverId,
      state: "open",
    });
    const notices: unknown = openNotices["notices"];
    assert(
      Array.isArray(notices) &&
        notices.some(
          (notice: unknown): boolean =>
            stringField(record(notice, "notice"), "notice_id") === noticeId,
        ),
      "Repository notice was not listed",
    );
    const resolvedNotice: Record<string, unknown> = await call(receiver, "resolve_notice", {
      actor_id: receiverId,
      notice_id: noticeId,
      resolution_note: "Production canary verified",
    });
    assert(
      record(resolvedNotice["notice"], "notice")["state"] === "resolved",
      "Repository notice did not resolve",
    );

    const ended: Record<string, unknown> = await call(receiver, "end_session", {
      agent_id: receiverId,
      expected_generation: receiverAgent["generation"],
      reason: "stop",
    });
    assert(ended["ended"] === 1, "Receiver default session did not end");
    const inactiveAgent: Record<string, unknown> = await call(receiver, "get_agent", {
      agent_id: receiverId,
    });
    assert(
      record(inactiveAgent["agent"], "agent")["state"] === "inactive",
      "Ended receiver session did not become inactive",
    );
    const inactiveDelivery: Record<string, unknown> = await call(sender, "send_message", {
      content: inactiveContent,
      idempotency_key: `live-inactive-${unique}`,
      recipient_id: receiverId,
      sender_id: senderId,
    });
    assert(
      inactiveDelivery["recipient_state"] === "inactive",
      "Inactive direct delivery did not report recipient state",
    );
    const closedAgent: Record<string, unknown> = await call(receiver, "close_agent", {
      agent_id: receiverId,
      expected_generation: receiverAgent["generation"],
      reason: "completed",
    });
    assert(
      record(closedAgent["agent"], "agent")["state"] === "closed" &&
        closedAgent["unread_count"] === 1,
      "Receiver did not close with its durable unread work preserved",
    );
    const closedSend: string = await callExpectingError(sender, "send_message", {
      content: "must not reach a closed production canary",
      recipient_id: receiverId,
      sender_id: senderId,
    });
    assert(closedSend.includes("is closed"), "Closed receiver accepted new work");
    const history: Record<string, unknown> = await call(receiver, "get_message_history", {
      agent_id: receiverId,
      generation: 1,
    });
    const historicalMessages: unknown = history["messages"];
    assert(
      Array.isArray(historicalMessages) &&
        historicalMessages.some(
          (message: unknown): boolean =>
            stringField(record(message, "historical message"), "content") === inactiveContent,
        ),
      "Closed generation history omitted inactive delivery",
    );
    const reopenedAgent: Record<string, unknown> = await call(receiver, "register_agent", {
      agent_id: receiverId,
      display_name: "Live canary receiver",
      session_key: "production-generation-two",
    });
    assert(
      record(reopenedAgent["agent"], "agent")["generation"] === 2,
      "Explicitly closed receiver did not advance generation",
    );
    const currentInbox: Record<string, unknown> = await call(receiver, "get_messages", {
      agent_id: receiverId,
      limit: 100,
      unread_only: false,
    });
    assert(
      Array.isArray(currentInbox["messages"]) && currentInbox["messages"].length === 0,
      "Reopened generation inherited historical messages",
    );

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

    e2eeResult = await runProductionE2eeCanary(operator, url, unique);

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
        agent_lifecycle: true,
        cross_tenant_denials: true,
        direct_message: true,
        e2ee: e2eeResult,
        generation_history: true,
        organization_broadcast: true,
        repository_notices: true,
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
