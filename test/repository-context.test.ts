import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  detectAgentClient,
  detectBranchName,
  detectRepositoryName,
  repositoryNameFromRemote,
} from "../src/context/repository-context.js";
import {
  agentClientFromInput,
  branchNameFromInput,
  repositoryNameFromInput,
} from "../src/domain/contracts.js";
import type { AgentClient, BranchName, RepositoryName } from "../src/domain/value-objects.js";

function requireRepositoryValue(repositoryName: RepositoryName | null): string {
  if (repositoryName === null) throw new Error("Expected repository context");
  return repositoryName.value;
}

function requireClientValue(client: AgentClient | null): "claude" | "codex" | "connector" {
  if (client === null) throw new Error("Expected client context");
  return client.value;
}

test("normalizes common Git remote formats to a portable repository name", (): void => {
  const remotes: readonly string[] = [
    "https://github.com/mattpatagon/murmur.git",
    "git@github.com:mattpatagon/murmur.git",
    "ssh://git@github.com/mattpatagon/murmur.git",
    "git://github.com/mattpatagon/murmur.git",
  ];
  remotes.forEach((remote: string): void => {
    expect(requireRepositoryValue(repositoryNameFromRemote(remote))).toBe("mattpatagon/murmur");
  });
});

test("detects this worktree's repository from origin", (): void => {
  const repositoryName: RepositoryName | null = detectRepositoryName({}, resolve("."));
  expect(requireRepositoryValue(repositoryName)).toBe("mattpatagon/murmur");
});

test("supports an explicit repository override outside a Git worktree", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-context-"));
  try {
    const repositoryName: RepositoryName | null = detectRepositoryName(
      { MURMUR_REPOSITORY: "mattpatagon/murmur" },
      directory,
    );
    expect(requireRepositoryValue(repositoryName)).toBe("mattpatagon/murmur");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("detects branch and client context with explicit overrides", (): void => {
  const branchName: BranchName | null = detectBranchName({
    MURMUR_BRANCH: "feature/agent-context",
  });
  if (branchName === null) throw new Error("Expected branch context");
  expect(branchName.value).toBe("feature/agent-context");

  const client: AgentClient | null = detectAgentClient({ MURMUR_CLIENT: "Claude" });
  if (client === null) throw new Error("Expected client context");
  expect(client.value).toBe("claude");
});

test("detects Claude and Codex from their host environments", (): void => {
  expect(requireClientValue(detectAgentClient({ CLAUDECODE: "1" }))).toBe("claude");
  expect(requireClientValue(detectAgentClient({ CODEX_THREAD_ID: "thread-id" }))).toBe("codex");
  expect(detectAgentClient({})).toBeNull();
});

test("allows a send call to override the server repository context", (): void => {
  const repositoryName: RepositoryName | null = repositoryNameFromInput(
    { repository: "another/project" },
    repositoryNameFromRemote("https://github.com/mattpatagon/murmur.git"),
  );
  expect(requireRepositoryValue(repositoryName)).toBe("another/project");
});

test("allows a send call to override server branch and client context", (): void => {
  const branchName: BranchName | null = branchNameFromInput(
    { branch: "feature/call-override" },
    detectBranchName({ MURMUR_BRANCH: "feature/server-default" }),
  );
  if (branchName === null) throw new Error("Expected branch context");
  expect(branchName.value).toBe("feature/call-override");

  const client: AgentClient | null = agentClientFromInput(
    { client: "claude" },
    detectAgentClient({ MURMUR_CLIENT: "codex" }),
  );
  if (client === null) throw new Error("Expected client context");
  expect(client.value).toBe("claude");
});

test("omits repository context when no portable origin is available", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-context-"));
  try {
    expect(detectRepositoryName({}, directory)).toBeNull();
    expect(repositoryNameFromRemote("/Users/example/private/repository")).toBeNull();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
