import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import process from "node:process";

import { AgentClient, BranchName, RepositoryName } from "../domain/value-objects.js";

const REMOTE_PATH_PATTERN: RegExp = /^[^\s:]+@[^\s:]+:(.+)$/u;

function normalizedPath(path: string): string {
  const withoutBoundarySlashes: string = path.replace(/^\/+|\/+$/gu, "");
  return withoutBoundarySlashes.endsWith(".git")
    ? withoutBoundarySlashes.slice(0, -4)
    : withoutBoundarySlashes;
}

export function repositoryNameFromRemote(remote: string): RepositoryName | null {
  const trimmed: string = remote.trim();
  if (trimmed === "") return null;

  let repositoryPath: string | null = null;
  try {
    const url: URL = new URL(trimmed);
    if (["git:", "http:", "https:", "ssh:"].includes(url.protocol)) {
      repositoryPath = normalizedPath(decodeURIComponent(url.pathname));
    }
  } catch (_error: unknown) {
    const match: RegExpMatchArray | null = trimmed.match(REMOTE_PATH_PATTERN);
    if (match !== null) {
      const path: string | undefined = match[1];
      if (path !== undefined) repositoryPath = normalizedPath(path);
    }
  }

  if (repositoryPath === null || repositoryPath === "") return null;
  try {
    return RepositoryName.parse(repositoryPath);
  } catch (_error: unknown) {
    return null;
  }
}

export function detectRepositoryName(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RepositoryName | null {
  const configured: string | undefined = environment["MURMUR_REPOSITORY"];
  if (configured !== undefined) return RepositoryName.parse(configured);

  const result: SpawnSyncReturns<string> = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error !== undefined) return null;
  return repositoryNameFromRemote(result.stdout);
}

export function detectBranchName(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BranchName | null {
  const configured: string | undefined = environment["MURMUR_BRANCH"];
  if (configured !== undefined) return BranchName.parse(configured);

  const result: SpawnSyncReturns<string> = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error !== undefined) return null;
  const branch: string = result.stdout.trim();
  return branch === "" ? null : BranchName.parse(branch);
}

export function detectAgentClient(
  environment: NodeJS.ProcessEnv = process.env,
): AgentClient | null {
  const configured: string | undefined = environment["MURMUR_CLIENT"];
  if (configured !== undefined) return AgentClient.parse(configured.trim().toLowerCase());

  if (
    environment["CLAUDECODE"] !== undefined ||
    environment["CLAUDE_CODE_ENTRYPOINT"] !== undefined
  ) {
    return AgentClient.parse("claude");
  }
  if (
    environment["CODEX_THREAD_ID"] !== undefined ||
    environment["CODEX_CI"] !== undefined ||
    environment["CODEX_WORKING_DIR"] !== undefined
  ) {
    return AgentClient.parse("codex");
  }
  return null;
}
