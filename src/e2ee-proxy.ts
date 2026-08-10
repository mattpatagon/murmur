#!/usr/bin/env bun

import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { detectBranchName, detectRepositoryName } from "./context/repository-context.js";
import {
  AgentClient,
  BranchName,
  type Clock,
  RepositoryName,
  SystemClock,
} from "./domain/value-objects.js";
import {
  E2eeHttpRemoteClient,
  type E2eeHttpRemoteClientConfig,
} from "./e2ee/http-remote-client.js";
import { LocalE2eeVault } from "./e2ee/local-vault.js";
import { E2eeProxyApplication } from "./e2ee/proxy-application.js";
import { getE2eeCapability } from "./e2ee/proxy-identity.js";
import { E2eeProxyService } from "./e2ee/proxy-service.js";
import type { E2eeProxyRemoteClient } from "./e2ee/remote-client.js";
import { defaultE2eeVaultPath } from "./e2ee/vault-paths.js";
import { logSafeError } from "./safe-errors.js";
import { MURMUR_TOKEN_ENV } from "./setup/user-configuration.js";

type ProxyArguments = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient;
  readonly endpoint: string;
  readonly repositoryName: RepositoryName | null;
  readonly trustOnFirstUse: boolean;
  readonly vaultPath: string;
};

export type E2eeProxyRuntime = {
  readonly clock: Clock;
  readonly connectRemote: (config: E2eeHttpRemoteClientConfig) => Promise<E2eeProxyRemoteClient>;
  readonly createTransport: () => Transport;
  readonly createVault: (path: string) => LocalE2eeVault;
  readonly detectBranchName: () => BranchName | null;
  readonly detectRepositoryName: () => RepositoryName | null;
  readonly environment: NodeJS.ProcessEnv;
  readonly onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
};

export type E2eeProxyHandle = {
  readonly application: E2eeProxyApplication;
  readonly shutdown: () => Promise<void>;
};

const DEFAULT_RUNTIME: E2eeProxyRuntime = {
  clock: new SystemClock(),
  connectRemote: async (config: E2eeHttpRemoteClientConfig): Promise<E2eeProxyRemoteClient> =>
    await E2eeHttpRemoteClient.connect(config),
  createTransport: (): Transport => new StdioServerTransport(),
  createVault: (path: string): LocalE2eeVault => new LocalE2eeVault(path),
  detectBranchName,
  detectRepositoryName,
  environment: process.env,
  onSignal: (signal: NodeJS.Signals, listener: () => void): void => {
    process.once(signal, listener);
  },
};

function nextArgument(arguments_: readonly string[], index: number, option: string): string {
  const value: string | undefined = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(arguments_: readonly string[], runtime: E2eeProxyRuntime): ProxyArguments {
  let branchName: BranchName | null = runtime.detectBranchName();
  let client: AgentClient | null = null;
  let endpoint: string | null = null;
  let repositoryName: RepositoryName | null = runtime.detectRepositoryName();
  let trustOnFirstUse: boolean = false;
  let vaultPath: string = defaultE2eeVaultPath(runtime.environment);
  for (let index: number = 0; index < arguments_.length; index += 1) {
    const argument: string | undefined = arguments_[index];
    switch (argument) {
      case "--branch":
        branchName = BranchName.parse(nextArgument(arguments_, index, argument));
        index += 1;
        break;
      case "--client":
        client = AgentClient.parse(nextArgument(arguments_, index, argument));
        index += 1;
        break;
      case "--repository":
        repositoryName = RepositoryName.parse(nextArgument(arguments_, index, argument));
        index += 1;
        break;
      case "--trust-on-first-use":
        trustOnFirstUse = true;
        break;
      case "--url":
        endpoint = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--vault-path":
        vaultPath = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown E2E proxy option: ${argument ?? ""}`);
    }
  }
  if (client === null) throw new Error("--client is required");
  if (endpoint === null) throw new Error("--url is required");
  return { branchName, client, endpoint, repositoryName, trustOnFirstUse, vaultPath };
}

function accessToken(environment: NodeJS.ProcessEnv): string {
  const token: string | undefined = environment[MURMUR_TOKEN_ENV];
  if (token === undefined || token.trim() === "") {
    throw new Error(`${MURMUR_TOKEN_ENV} is required for the encrypted Murmur proxy`);
  }
  return token;
}

export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  runtime: E2eeProxyRuntime = DEFAULT_RUNTIME,
): Promise<E2eeProxyHandle> {
  const parsed: ProxyArguments = parseArguments(arguments_, runtime);
  const remote: E2eeProxyRemoteClient = await runtime.connectRemote({
    branch: parsed.branchName === null ? null : parsed.branchName.value,
    client: parsed.client.value,
    endpoint: parsed.endpoint,
    repository: parsed.repositoryName === null ? null : parsed.repositoryName.value,
    token: accessToken(runtime.environment),
  });
  let vault: LocalE2eeVault;
  try {
    await getE2eeCapability(remote, false);
    vault = runtime.createVault(parsed.vaultPath);
  } catch (error: unknown) {
    await remote.close().catch((_closeError: unknown): void => undefined);
    throw error;
  }
  const service: E2eeProxyService = new E2eeProxyService({
    branchName: parsed.branchName,
    client: parsed.client,
    clock: runtime.clock,
    remote,
    repositoryName: parsed.repositoryName,
    trustOnFirstUse: parsed.trustOnFirstUse,
    vault,
  });
  const application: E2eeProxyApplication = new E2eeProxyApplication(service);
  try {
    await application.server.connect(runtime.createTransport());
  } catch (error: unknown) {
    await application.close().catch((_closeError: unknown): void => undefined);
    throw error;
  }
  let shutdownPromise: Promise<void> | null = null;
  const shutdown: () => Promise<void> = async (): Promise<void> => {
    if (shutdownPromise === null) shutdownPromise = application.close();
    await shutdownPromise;
  };
  runtime.onSignal("SIGINT", (): void => {
    void shutdown().catch((error: unknown): void => {
      logSafeError("Murmur E2E proxy shutdown failed", error);
      process.exitCode = 1;
    });
  });
  runtime.onSignal("SIGTERM", (): void => {
    void shutdown().catch((error: unknown): void => {
      logSafeError("Murmur E2E proxy shutdown failed", error);
      process.exitCode = 1;
    });
  });
  return { application, shutdown };
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur E2E proxy startup failed", error);
    process.exitCode = 1;
  });
}
