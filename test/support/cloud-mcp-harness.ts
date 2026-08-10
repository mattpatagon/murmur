import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Sql } from "postgres";
import type { z } from "zod";

import { databaseUrlForDocker } from "../../scripts/require-cross-platform-test.js";
import { FOUNDING_TENANT_ID } from "../../src/domain/value-objects.js";
import { POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED } from "../../src/storage/postgres-message-store.js";

export const cloudDatabaseUrl: string | undefined = process.env["MURMUR_TEST_DATABASE_URL"];
export const dockerImage: string | undefined = process.env["MURMUR_TEST_DOCKER_IMAGE"];
const PROJECT_ROOT: string = resolve(".");
export const repositoryName: string = "mattpatagon/murmur";
export const branchName: string = "feature/cloud-context";
export const clientName: "codex" = "codex";

export type ClientHarness = {
  readonly client: Client;
  readonly transport: StdioClientTransport;
};

type AdvisoryWaiterCountRow = {
  readonly count: number | string;
};

export type DeferredSignal = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

export function deferredSignal(): DeferredSignal {
  let resolver: (() => void) | null = null;
  const promise: Promise<void> = new Promise((resolvePromise: () => void): void => {
    resolver = resolvePromise;
  });
  return {
    promise,
    resolve: (): void => {
      const currentResolver: (() => void) | null = resolver;
      if (currentResolver === null) throw new Error("Deferred signal was not initialized");
      currentResolver();
    },
  };
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command '${command}' failed with status ${String(result.status)}:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export function packMurmur(packageDirectory: string): string {
  mkdirSync(packageDirectory, { recursive: true });
  runCommand(
    process.execPath,
    ["pm", "pack", "--destination", packageDirectory, "--ignore-scripts"],
    PROJECT_ROOT,
  );
  const archives: string[] = readdirSync(packageDirectory).filter((fileName: string): boolean =>
    fileName.endsWith(".tgz"),
  );
  const archiveName: string | undefined = archives[0];
  if (archiveName === undefined) throw new Error("Murmur package archive was not created");
  return join(packageDirectory, archiveName);
}

export function installMurmur(packageArchive: string, machineRoot: string): string {
  mkdirSync(machineRoot, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_INSTALL: machineRoot,
  };
  runCommand(process.execPath, ["install", "--global", packageArchive], machineRoot, environment);
  return join(machineRoot, "bin");
}

function hostChildEnvironment(databaseUrl: string): Record<string, string> {
  const environment: Record<string, string> = {};
  const hostPath: string | undefined = process.env["PATH"];
  if (hostPath === undefined) throw new Error("PATH is required for the portability test");
  environment["PATH"] = hostPath;
  environment["MURMUR_DATABASE_URL"] = databaseUrl;
  environment["MURMUR_BRANCH"] = branchName;
  environment["MURMUR_CLIENT"] = clientName;
  environment["MURMUR_REPOSITORY"] = repositoryName;
  const databaseCaPath: string | undefined = process.env["MURMUR_DATABASE_CA_PATH"];
  if (databaseCaPath !== undefined) environment["MURMUR_DATABASE_CA_PATH"] = databaseCaPath;
  const insecureDatabaseTls: string | undefined = process.env["MURMUR_DATABASE_TLS_INSECURE"];
  if (insecureDatabaseTls !== undefined) {
    environment["MURMUR_DATABASE_TLS_INSECURE"] = insecureDatabaseTls;
  }
  return environment;
}

function cloudChildEnvironment(
  databaseUrl: string,
  binaryDirectory: string,
): Record<string, string> {
  const environment: Record<string, string> = hostChildEnvironment(databaseUrl);
  const hostPath: string = environment["PATH"] ?? "";
  environment["PATH"] =
    `${binaryDirectory}${delimiter}${dirname(process.execPath)}${delimiter}${hostPath}`;
  return environment;
}

export async function connectClient(
  name: string,
  databaseUrl: string,
  binaryDirectory: string,
  workspace: string,
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: [],
    command: "murmur-mcp",
    cwd: workspace,
    env: cloudChildEnvironment(databaseUrl, binaryDirectory),
    stderr: "inherit",
  });
  await client.connect(transport);
  return { client, transport };
}

export async function connectProjectClient(
  name: string,
  databaseUrl: string,
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: ["run", "src/server.ts"],
    command: "bun",
    cwd: PROJECT_ROOT,
    env: hostChildEnvironment(databaseUrl),
    stderr: "inherit",
  });
  await client.connect(transport);
  return { client, transport };
}

export async function connectDockerClient(
  name: string,
  databaseUrl: string,
  imageName: string,
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: [
      "run",
      "--rm",
      "--interactive",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--mount",
      `type=bind,source=${PROJECT_ROOT},target=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--env",
      "MURMUR_DATABASE_URL",
      "--env",
      "MURMUR_DATABASE_TLS_INSECURE",
      "--env",
      "MURMUR_BRANCH",
      "--env",
      "MURMUR_CLIENT",
      "--env",
      "MURMUR_REPOSITORY",
      imageName,
      "bun",
      "run",
      "src/server.ts",
    ],
    command: "docker",
    env: hostChildEnvironment(databaseUrlForDocker(databaseUrl)),
    stderr: "inherit",
  });
  await client.connect(transport);
  return { client, transport };
}

export async function callValidated<T>(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const rawResult: unknown = await client.callTool({
    arguments: argumentsValue,
    name,
  });
  const result: CallToolResult = CallToolResultSchema.parse(rawResult);
  if (result.isError === true) {
    throw new Error(`MCP tool '${name}' failed: ${JSON.stringify(result.content)}`);
  }
  return schema.parse(result.structuredContent);
}

export async function notificationTimeout(): Promise<never> {
  await Bun.sleep(8_000);
  throw new Error("Cloud push notification timed out");
}

export async function waitForMessageCommitLockWaiters(
  database: Sql,
  recipientId: string,
  expected: number,
): Promise<void> {
  const tenantRecipientId: string = `${FOUNDING_TENANT_ID}:${recipientId}`;
  let attempt: number = 0;
  while (attempt < 200) {
    const rows: AdvisoryWaiterCountRow[] = await database<AdvisoryWaiterCountRow[]>`
      SELECT COUNT(*) AS count
      FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory'
        AND classid = (
          pg_catalog.hashtextextended(
            ${tenantRecipientId},
            ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
          ) >> 32 & 4294967295::bigint
        )::oid
        AND objid = (
          pg_catalog.hashtextextended(
            ${tenantRecipientId},
            ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
          ) & 4294967295::bigint
        )::oid
        AND objsubid = 1
        AND NOT granted
    `;
    const row: AdvisoryWaiterCountRow | undefined = rows[0];
    if (row === undefined) throw new Error("Postgres did not return an advisory lock count");
    if (Number(row.count) >= expected) return;
    await Bun.sleep(10);
    attempt += 1;
  }
  throw new Error(`Timed out waiting for ${String(expected)} message commit lock waiters`);
}
