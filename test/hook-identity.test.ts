import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type AgentIdentity,
  deriveAgentIdentity,
  handleHook,
  type InboxSummary,
} from "../src/hook.js";

test("derives a stable agent ID from machine, client, and workspace", (): void => {
  const environment: NodeJS.ProcessEnv = {
    MURMUR_BRANCH: "feature/broadcast-hook",
    MURMUR_MACHINE_ID: "dev vm",
    MURMUR_REPOSITORY: "mattpatagon/murmur",
    MURMUR_WORKSPACE_ID: "cancun-v1",
  };
  const first: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment);
  const second: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment);
  const claude: AgentIdentity = deriveAgentIdentity("claude", "/work/murmur", environment);
  expect(first.agentId).toBe(second.agentId);
  expect(first.agentId).toStartWith("dev-vm:codex:cancun-v1:");
  expect(first.branch).toBe("feature/broadcast-hook");
  expect(first.repository).toBe("mattpatagon/murmur");
  expect(claude.agentId).not.toBe(first.agentId);
});

test("derives distinct stable agent IDs for concurrent sessions in one workspace", (): void => {
  const environment: NodeJS.ProcessEnv = {
    MURMUR_MACHINE_ID: "dev-vm",
    MURMUR_WORKSPACE_ID: "shared-checkout",
  };
  const first: AgentIdentity = deriveAgentIdentity(
    "codex",
    "/work/murmur",
    environment,
    "codex-session-one",
  );
  const repeated: AgentIdentity = deriveAgentIdentity(
    "codex",
    "/work/murmur",
    environment,
    "codex-session-one",
  );
  const concurrent: AgentIdentity = deriveAgentIdentity(
    "codex",
    "/work/murmur",
    environment,
    "codex-session-two",
  );
  const otherWorkspace: AgentIdentity = deriveAgentIdentity(
    "codex",
    "/work/other-murmur",
    environment,
    "codex-session-one",
  );
  const resolvedWorkspace: string = resolve("/work/murmur");
  const expectedLegacyHash: string = createHash("sha256")
    .update(resolvedWorkspace)
    .digest("hex")
    .slice(0, 10);
  const expectedSessionHash: string = createHash("sha256")
    .update(resolvedWorkspace)
    .update("\u0000")
    .update("codex-session-one")
    .digest("hex")
    .slice(0, 10);
  expect(first.agentId).toBe(repeated.agentId);
  expect(first.agentId).not.toBe(concurrent.agentId);
  expect(first.agentId).not.toBe(otherWorkspace.agentId);
  expect(first.workspaceHash).toBe(expectedSessionHash);
  expect(deriveAgentIdentity("codex", "/work/murmur", environment).workspaceHash).toBe(
    expectedLegacyHash,
  );
  expect(first.agentId).not.toContain("codex-session-one");
  expect(concurrent.agentId).not.toContain("codex-session-two");
});

test("preserves checkout-only identity when the host session ID is absent or blank", (): void => {
  const environment: NodeJS.ProcessEnv = {
    MURMUR_MACHINE_ID: "dev-vm",
    MURMUR_WORKSPACE_ID: "shared-checkout",
  };
  const absent: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment);
  const empty: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment, "");
  const blank: AgentIdentity = deriveAgentIdentity("codex", "/work/murmur", environment, " \t ");
  expect(empty).toEqual(absent);
  expect(blank).toEqual(absent);
});

test("passes the host session ID through automatic hook identity generation", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-session-identity-"));
  const agentIds: string[] = [];
  const checkInbox: (identity: AgentIdentity) => Promise<InboxSummary> = async (
    identity: AgentIdentity,
  ): Promise<InboxSummary> => {
    agentIds.push(identity.agentId);
    return { agentGeneration: 1, inboxVersion: 0, messageCount: 0, senderIds: [] };
  };
  const environment: NodeJS.ProcessEnv = {
    MURMUR_API_TOKEN: "test-token",
    MURMUR_MACHINE_ID: "dev-vm",
  };
  try {
    await handleHook(
      { cwd: "/work/shared", hook_event_name: "SessionStart", session_id: "session-one" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    await handleHook(
      { cwd: "/work/shared", hook_event_name: "SessionStart", session_id: "session-two" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    await handleHook(
      { cwd: "/work/shared", hook_event_name: "SessionStart", session_id: "session-one" },
      "codex",
      { cacheDirectory: directory, checkInbox, environment, now: 20_000 },
    );
    expect(agentIds).toHaveLength(3);
    expect(agentIds[0]).not.toBe(agentIds[1]);
    expect(agentIds[0]).toBe(agentIds[2]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("sanitizes identity parts and falls back for empty values", (): void => {
  const identity: AgentIdentity = deriveAgentIdentity("codex", "/work/repo", {
    MURMUR_MACHINE_ID: "!!!",
    MURMUR_WORKSPACE_ID: `${"x".repeat(60)} / ignored`,
  });
  expect(identity.machine).toBe("machine");
  expect(identity.workspace).toBe("x".repeat(50));
  expect(identity.workspaceHash).toHaveLength(10);
});
