import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type HookOutput, handleHook, type InboxSummary, summarizeHookInbox } from "../src/hook.js";

function message(sequence: number, senderId: string, authority?: "orchestrator"): unknown {
  return {
    content: `message-${String(sequence)}`,
    context: {},
    created_at: "2026-08-10T00:00:00.000Z",
    expires_at: "2026-09-09T00:00:00.000Z",
    message_id: `51000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    message_kind: "message",
    orchestrator_policy_id: null,
    read_at: null,
    recipient_id: "worker",
    ...(authority === undefined ? {} : { sender_authority: authority }),
    sender_id: senderId,
    sequence,
    thread_id: `thread-${String(sequence)}`,
  };
}

function rawInbox(messages: readonly unknown[]): unknown {
  return { agent_id: "worker", inbox_version: messages.length, messages };
}

test("derives verified authority counts from mixed hook inbox payloads", (): void => {
  const mixed: InboxSummary = summarizeHookInbox(
    rawInbox([message(1, "peer"), message(2, "boss", "orchestrator")]),
    0,
    { kind: "none" },
  );
  expect(mixed).toEqual({
    inboxVersion: 2,
    messageCount: 2,
    orchestration: { kind: "none" },
    orchestratorMessageCount: 1,
    senderIds: ["peer", "boss"],
  });
  expect(summarizeHookInbox(rawInbox([]), 7, { kind: "none" }).orchestratorMessageCount).toBe(0);
  expect(
    summarizeHookInbox(
      rawInbox([message(8, "boss-a", "orchestrator"), message(9, "boss-b", "orchestrator")]),
      7,
      { kind: "none" },
    ).orchestratorMessageCount,
  ).toBe(2);
});

test("renders notification authority from the parsed inbox summary", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-authority-"));
  const summary: InboxSummary = summarizeHookInbox(
    rawInbox([message(1, "peer"), message(2, "boss", "orchestrator")]),
    0,
    { kind: "none" },
  );
  try {
    const output: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "PostToolUse" },
      "codex",
      {
        cacheDirectory: directory,
        checkInbox: async (): Promise<InboxSummary> => summary,
        environment: {
          HOME: directory,
          MURMUR_API_TOKEN: "test-token",
          MURMUR_MACHINE_ID: "vm",
        },
        now: 20_000,
      },
    );
    if (output === null) throw new Error("Expected a hook notification");
    expect(output.systemMessage).toBe(
      "Murmur: 2 unread messages (1 from a verified orchestrator) from peer, boss.",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("renders a singular coordination notice on session start", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-hook-notice-"));
  try {
    const output: HookOutput | null = await handleHook(
      { cwd: "/work/repo", hook_event_name: "SessionStart" },
      "codex",
      {
        cacheDirectory: directory,
        checkInbox: async (): Promise<InboxSummary> => ({
          inboxVersion: 1,
          messageCount: 0,
          noticeCount: 1,
          senderIds: [],
        }),
        environment: {
          HOME: directory,
          MURMUR_API_TOKEN: "test-token",
          MURMUR_MACHINE_ID: "vm",
        },
        now: 20_000,
      },
    );
    if (output === null) throw new Error("Expected a hook notice");
    expect(output.systemMessage).toBe("Murmur: 0 unread messages. 1 open coordination notice.");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
