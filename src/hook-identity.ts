import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";

import { detectBranchName, detectRepositoryName } from "./context/repository-context.js";
import type { MurmurClient } from "./setup/user-configuration.js";

export type AgentIdentity = {
  readonly agentId: string;
  readonly branch: string | null;
  readonly client: MurmurClient;
  readonly displayName: string;
  readonly machine: string;
  readonly repository: string | null;
  readonly workspace: string;
  readonly workspaceHash: string;
};

function sanitizedPart(value: string, fallback: string): string {
  const sanitized: string = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 50);
  return sanitized === "" ? fallback : sanitized;
}

export function deriveAgentIdentity(
  client: MurmurClient,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  sessionId?: string | undefined,
): AgentIdentity {
  const resolvedWorkspace: string = resolve(cwd);
  const hash: ReturnType<typeof createHash> = createHash("sha256").update(resolvedWorkspace);
  if (sessionId !== undefined && sessionId.trim() !== "") {
    hash.update("\u0000").update(sessionId);
  }
  const workspaceHash: string = hash.digest("hex").slice(0, 10);
  const machine: string = sanitizedPart(environment["MURMUR_MACHINE_ID"] ?? hostname(), "machine");
  const workspace: string = sanitizedPart(
    environment["MURMUR_WORKSPACE_ID"] ?? basename(resolvedWorkspace),
    "workspace",
  );
  const agentId: string = `${machine}:${client}:${workspace}:${workspaceHash}`;
  const detectedRepository: ReturnType<typeof detectRepositoryName> = detectRepositoryName(
    environment,
    resolvedWorkspace,
  );
  const repository: string | null = detectedRepository === null ? null : detectedRepository.value;
  const detectedBranch: ReturnType<typeof detectBranchName> = detectBranchName(
    environment,
    resolvedWorkspace,
  );
  const branch: string | null = detectedBranch === null ? null : detectedBranch.value;
  return {
    agentId,
    branch,
    client,
    displayName: `${client} on ${machine} (${workspace})`,
    machine,
    repository,
    workspace,
    workspaceHash,
  };
}
