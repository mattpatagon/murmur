import { dirname, resolve } from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

const LAUNCHER_PATH: string = resolve("scripts/murmur-mcp");

export type ClientHarness = {
  readonly client: Client;
  readonly transport: StdioClientTransport;
};

export type ResourceContent = ReadResourceResult["contents"][number];

export function bunInstallFromCurrentExecutable(): string {
  return dirname(dirname(process.execPath));
}

export function childEnvironment(databasePath: string): Record<string, string> {
  const environment: Record<string, string> = {};
  const keys: string[] = Object.keys(process.env);
  let index: number = 0;
  while (index < keys.length) {
    const key: string | undefined = keys[index];
    if (key === undefined) throw new Error("Environment key disappeared during iteration");
    const value: string | undefined = process.env[key];
    if (value !== undefined) environment[key] = value;
    index += 1;
  }
  environment["MURMUR_DB_PATH"] = databasePath;
  environment["MURMUR_BRANCH"] = "feature/mcp-context";
  environment["MURMUR_CLIENT"] = "codex";
  return environment;
}

export async function connectClientWithEnvironment(
  name: string,
  environment: Record<string, string>,
  cwd: string = resolve("."),
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: [],
    command: LAUNCHER_PATH,
    cwd,
    env: environment,
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

function isolatedChildEnvironment(databasePath: string): Record<string, string> {
  return {
    BUN_INSTALL: bunInstallFromCurrentExecutable(),
    MURMUR_DB_PATH: databasePath,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  };
}

export async function connectClient(name: string, databasePath: string): Promise<ClientHarness> {
  return await connectClientWithEnvironment(name, childEnvironment(databasePath));
}

export async function connectGenericClient(
  name: string,
  databasePath: string,
  cwd: string,
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: ["run", resolve("src/server.ts")],
    command: process.execPath,
    cwd,
    env: isolatedChildEnvironment(databasePath),
    stderr: "pipe",
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
    const serialized: string = JSON.stringify(result.content);
    throw new Error(`MCP tool '${name}' failed: ${serialized}`);
  }
  return schema.parse(result.structuredContent);
}

export async function notificationTimeout(): Promise<never> {
  await Bun.sleep(3_000);
  throw new Error("Push notification timed out");
}
