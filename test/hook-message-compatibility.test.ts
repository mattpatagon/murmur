import { expect, test } from "bun:test";

import { parseHookInbox, parseHookRegistration } from "../src/hook-message-compatibility.js";

test("accepts old and future inbox message shapes at the hook boundary", (): void => {
  const parsed: ReturnType<typeof parseHookInbox> = parseHookInbox({
    agent_id: "hook-agent",
    future_top_level_field: "ignored",
    inbox_version: 1,
    messages: [
      {
        content: "legacy message",
        context: { future_context_field: "ignored" },
        created_at: "2026-08-10T00:00:00.000Z",
        expires_at: "2026-09-09T00:00:00.000Z",
        future_message_field: "ignored",
        message_id: "51000000-0000-4000-8000-000000000001",
        read_at: null,
        recipient_id: "hook-agent",
        sender_id: "peer-agent",
        sequence: 1,
        thread_id: "legacy-thread",
      },
    ],
  });
  const message: ReturnType<typeof parseHookInbox>["messages"][number] | undefined =
    parsed.messages[0];
  if (message === undefined) throw new Error("Expected a compatible hook message");
  expect(message.sender_authority).toBe("peer");
  expect(message.message_kind).toBe("message");
  expect(message.orchestrator_policy_id).toBeNull();
});

test("defaults missing registration authority during old-server deploy skew", (): void => {
  const parsed: ReturnType<typeof parseHookRegistration> = parseHookRegistration({
    agent: {
      agent_id: "hook-agent",
      closed_at: null,
      close_reason: null,
      created_at: "2026-08-10T00:00:00.000Z",
      display_name: "Hook Agent",
      generation: 1,
      last_seen_at: "2026-08-10T00:00:00.000Z",
      lease_expires_at: "2026-08-10T01:00:00.000Z",
      live_session_count: 1,
      metadata: {},
      state: "active",
    },
    inbox_uri: "murmur://inbox/hook-agent",
    lease_minutes: 60,
    reopened: false,
    repository_diverged: false,
    retention_days: 30,
  });
  expect(parsed.agent.authority).toBe("peer");
  expect(parsed.agent.generation).toBe(1);
});
