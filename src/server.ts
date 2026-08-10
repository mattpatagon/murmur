#!/usr/bin/env bun

import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  detectAgentClient,
  detectBranchName,
  detectRepositoryName,
} from "./context/repository-context.js";
import type { AgentClient, BranchName, RepositoryName } from "./domain/value-objects.js";
import { MurmurApplication } from "./mcp/murmur-application.js";
import { logSafeError } from "./safe-errors.js";
import { createStore } from "./storage/create-store.js";
import type { MessageStore } from "./storage/message-store.js";

export type StdioServerRuntime = {
  readonly createStore: () => Promise<MessageStore>;
  readonly createTransport: () => Transport;
  readonly detectBranchName: () => BranchName | null;
  readonly detectClient: () => AgentClient | null;
  readonly detectRepositoryName: () => RepositoryName | null;
  readonly onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
};

export type StdioServerHandle = {
  readonly application: MurmurApplication;
  readonly shutdown: () => Promise<void>;
};

const DEFAULT_RUNTIME: StdioServerRuntime = {
  createStore: async (): Promise<MessageStore> => await createStore(),
  createTransport: (): Transport => new StdioServerTransport(),
  detectBranchName,
  detectClient: detectAgentClient,
  detectRepositoryName,
  onSignal: (signal: NodeJS.Signals, listener: () => void): void => {
    process.once(signal, listener);
  },
};

export async function main(
  runtime: StdioServerRuntime = DEFAULT_RUNTIME,
): Promise<StdioServerHandle> {
  const store: MessageStore = await runtime.createStore();
  const branchName: BranchName | null = runtime.detectBranchName();
  const client: AgentClient | null = runtime.detectClient();
  const repositoryName: RepositoryName | null = runtime.detectRepositoryName();
  const application: MurmurApplication = new MurmurApplication({
    branchName,
    client,
    repositoryName,
    store,
  });
  const transport: Transport = runtime.createTransport();
  await application.server.connect(transport);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown: () => Promise<void> = async (): Promise<void> => {
    if (shutdownPromise === null) shutdownPromise = application.close();
    await shutdownPromise;
  };
  runtime.onSignal("SIGINT", (): void => {
    void shutdown().catch((error: unknown): void => {
      logSafeError("Murmur shutdown failed", error);
      process.exitCode = 1;
    });
  });
  runtime.onSignal("SIGTERM", (): void => {
    void shutdown().catch((error: unknown): void => {
      logSafeError("Murmur shutdown failed", error);
      process.exitCode = 1;
    });
  });
  return { application, shutdown };
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur startup failed", error);
    process.exitCode = 1;
  });
}
