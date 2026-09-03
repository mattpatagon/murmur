#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import process from "node:process";

import { runE2eeCli } from "./e2ee/cli.js";

import {
  DEFAULT_MURMUR_URL,
  installUserConfiguration,
  MURMUR_TOKEN_ENV,
  type MurmurClient,
} from "./setup/user-configuration.js";

type SetupArguments = {
  readonly clients: readonly MurmurClient[];
  readonly e2ee: boolean;
  readonly hookExecutable: string | null;
  readonly proxyExecutable: string | null;
  readonly replace: boolean;
  readonly url: string;
  readonly vaultPath: string | null;
};

export type SetupAction = (arguments_: readonly string[]) => readonly string[];

const HELP: string = `Murmur user-level setup

Usage:
  murmur setup --user [--codex] [--claude] [--e2ee] [--replace] [--url URL]
  murmur e2ee <command> [options]

The default is to configure both Codex and Claude. The command adds the remote
Murmur MCP server and passive SessionStart, UserPromptSubmit, PostToolUse, and
Stop hooks. Hooks check for unread messages only while an agent is active; they
do not wake an idle agent.

Options:
  --codex               Configure Codex
  --claude              Configure Claude Code
  --e2ee                Use the local end-to-end encryption proxy
  --replace             Replace a conflicting Murmur MCP entry
  --url URL             MCP endpoint (default: ${DEFAULT_MURMUR_URL})
  --vault-path PATH     Absolute E2E vault path for both proxy and hooks
  --user                Required acknowledgement of user-level scope
  -h, --help            Show this help

Authentication:
  Set ${MURMUR_TOKEN_ENV} in the environment that launches Codex and Claude.
  The token is referenced by name and is never copied into client settings.
`;

function nextArgument(arguments_: readonly string[], index: number, option: string): string {
  const value: string | undefined = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseSetupArguments(arguments_: readonly string[]): SetupArguments {
  const clients: MurmurClient[] = [];
  let hookExecutable: string | null = null;
  let proxyExecutable: string | null = null;
  let e2ee: boolean = false;
  let replace: boolean = false;
  let url: string = DEFAULT_MURMUR_URL;
  let userScope: boolean = false;
  let vaultPath: string | null = null;

  for (let index: number = 0; index < arguments_.length; index += 1) {
    const argument: string | undefined = arguments_[index];
    switch (argument) {
      case "--claude":
        clients.push("claude");
        break;
      case "--codex":
        clients.push("codex");
        break;
      case "--e2ee":
        e2ee = true;
        break;
      case "--hook-executable":
        hookExecutable = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--replace":
        replace = true;
        break;
      case "--proxy-executable":
        proxyExecutable = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--url":
        url = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--user":
        userScope = true;
        break;
      case "--vault-path":
        vaultPath = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown setup option: ${argument ?? ""}`);
    }
  }

  if (!userScope) {
    throw new Error("Murmur setup currently supports user scope only. Rerun with --user.");
  }
  if (vaultPath !== null && (!e2ee || !isAbsolute(vaultPath))) {
    throw new Error("--vault-path requires --e2ee and an absolute path");
  }
  const parsedUrl: URL = new URL(url);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new Error("The Murmur URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  return {
    clients: clients.length === 0 ? ["codex", "claude"] : [...new Set(clients)],
    e2ee,
    hookExecutable,
    proxyExecutable,
    replace,
    url: parsedUrl.toString(),
    vaultPath,
  };
}

function resolveProxyExecutable(configured: string | null): string {
  if (configured !== null) {
    if (!existsSync(configured)) throw new Error(`E2E proxy executable not found: ${configured}`);
    return configured;
  }
  const executable: string | null = Bun.which("murmur-e2ee-proxy");
  if (executable === null) {
    throw new Error(
      "murmur-e2ee-proxy is not on PATH. Install Murmur globally, then run setup again.",
    );
  }
  return executable;
}

function resolveHookExecutable(configured: string | null): string {
  if (configured !== null) {
    if (!existsSync(configured)) throw new Error(`Hook executable not found: ${configured}`);
    return configured;
  }
  const executable: string | null = Bun.which("murmur-hook");
  if (executable === null) {
    throw new Error(
      "murmur-hook is not on PATH. Install Murmur globally, then run murmur setup again.",
    );
  }
  return executable;
}

export function setup(arguments_: readonly string[]): readonly string[] {
  const parsed: SetupArguments = parseSetupArguments(arguments_);
  const hookExecutable: string = resolveHookExecutable(parsed.hookExecutable);
  const proxyExecutable: string | undefined = parsed.e2ee
    ? resolveProxyExecutable(parsed.proxyExecutable)
    : undefined;
  return installUserConfiguration({
    clients: parsed.clients,
    e2ee: parsed.e2ee,
    e2eeProxyExecutable: proxyExecutable,
    hookExecutable,
    replace: parsed.replace,
    url: parsed.url,
    ...(parsed.vaultPath === null ? {} : { e2eeVaultPath: parsed.vaultPath }),
  });
}

export function formatSetupResult(
  changedPaths: readonly string[],
  tokenConfigured: boolean,
): string {
  let output: string;
  if (changedPaths.length === 0) {
    output = "Murmur is already configured for the selected clients.\n";
  } else {
    output = "Configured Murmur user-level MCP and passive notifications:\n";
    for (const path of changedPaths) output += `  ${path}\n`;
  }
  if (tokenConfigured) {
    output += `\nAuthentication uses ${MURMUR_TOKEN_ENV}; no token was written to settings.\n`;
  } else {
    output +=
      `\nWarning: ${MURMUR_TOKEN_ENV} is not set in this process. ` +
      "Set it where Codex and Claude are launched.\n";
  }
  return `${output}Restart active Codex and Claude sessions to load the hooks.\n`;
}

export function runCli(
  arguments_: readonly string[],
  setupAction: SetupAction = setup,
  token: string | undefined = process.env[MURMUR_TOKEN_ENV],
): string {
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
    return HELP;
  }
  if (arguments_[0] !== "setup") {
    throw new Error(`Unknown command: ${arguments_[0] ?? ""}\n\n${HELP}`);
  }
  if (arguments_[1] === "--help" || arguments_[1] === "-h") {
    return HELP;
  }
  const changedPaths: readonly string[] = setupAction(arguments_.slice(1));
  return formatSetupResult(changedPaths, token !== undefined && token.trim() !== "");
}

export async function runCliAsync(
  arguments_: readonly string[],
  setupAction: SetupAction = setup,
  token: string | undefined = process.env[MURMUR_TOKEN_ENV],
): Promise<string> {
  if (arguments_[0] === "e2ee") return await runE2eeCli(arguments_.slice(1));
  return runCli(arguments_, setupAction, token);
}

if (import.meta.main) {
  runCliAsync(process.argv.slice(2)).then(
    (output: string): void => {
      process.stdout.write(output);
    },
    (error: unknown): void => {
      const message: string = error instanceof Error ? error.message : String(error);
      process.stderr.write(`murmur: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
