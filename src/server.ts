#!/usr/bin/env bun

import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  detectAgentClient,
  detectBranchName,
  detectRepositoryName,
} from "./context/repository-context.js";
import { MurmurApplication } from "./mcp/murmur-application.js";
import type { AgentClient, BranchName, RepositoryName } from "./domain/value-objects.js";
import { createStore } from "./storage/create-store.js";
import type { MessageStore } from "./storage/message-store.js";
import { logSafeError } from "./safe-errors.js";

export async function main(): Promise<void> {
  const store: MessageStore = await createStore();
  const branchName: BranchName | null = detectBranchName();
  const client: AgentClient | null = detectAgentClient();
  const repositoryName: RepositoryName | null = detectRepositoryName();
  const application: MurmurApplication = new MurmurApplication({
    branchName,
    client,
    repositoryName,
    store,
  });
  const transport: StdioServerTransport = new StdioServerTransport();
  await application.server.connect(transport);

  let shuttingDown: boolean = false;
  const shutdown: () => Promise<void> = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await application.close();
  };
  process.once("SIGINT", (): void => {
    void shutdown().catch((error: unknown): void => {
      logSafeError("Murmur shutdown failed", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", (): void => {
    void shutdown().catch((error: unknown): void => {
      logSafeError("Murmur shutdown failed", error);
      process.exitCode = 1;
    });
  });
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur startup failed", error);
    process.exitCode = 1;
  });
}
