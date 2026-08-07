#!/usr/bin/env bun

import { existsSync } from "node:fs";
import process from "node:process";

import {
  DEFAULT_MURMUR_URL,
  installUserConfiguration,
  MURMUR_TOKEN_ENV,
  type MurmurClient,
} from "./setup/user-configuration.js";

type SetupArguments = {
  readonly clients: readonly MurmurClient[];
  readonly hookExecutable: string | null;
  readonly replace: boolean;
  readonly url: string;
};

const HELP: string = `Murmur user-level setup

Usage:
  murmur setup --user [--codex] [--claude] [--replace] [--url URL]

The default is to configure both Codex and Claude. The command adds the remote
Murmur MCP server and passive SessionStart, UserPromptSubmit, PostToolUse, and
Stop hooks. Hooks check for unread messages only while an agent is active; they
do not wake an idle agent.

Options:
  --codex               Configure Codex
  --claude              Configure Claude Code
  --replace             Replace a conflicting Murmur MCP entry
  --url URL             MCP endpoint (default: ${DEFAULT_MURMUR_URL})
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
  let replace: boolean = false;
  let url: string = DEFAULT_MURMUR_URL;
  let userScope: boolean = false;

  for (let index: number = 0; index < arguments_.length; index += 1) {
    const argument: string | undefined = arguments_[index];
    switch (argument) {
      case "--claude":
        clients.push("claude");
        break;
      case "--codex":
        clients.push("codex");
        break;
      case "--hook-executable":
        hookExecutable = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--replace":
        replace = true;
        break;
      case "--url":
        url = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--user":
        userScope = true;
        break;
      default:
        throw new Error(`Unknown setup option: ${argument ?? ""}`);
    }
  }

  if (!userScope) {
    throw new Error("Murmur setup currently supports user scope only. Rerun with --user.");
  }
  const parsedUrl: URL = new URL(url);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new Error("The Murmur URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  return {
    clients: clients.length === 0 ? ["codex", "claude"] : [...new Set(clients)],
    hookExecutable,
    replace,
    url: parsedUrl.toString(),
  };
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
  return installUserConfiguration({
    clients: parsed.clients,
    hookExecutable,
    replace: parsed.replace,
    url: parsed.url,
  });
}

function printSetupResult(changedPaths: readonly string[]): void {
  if (changedPaths.length === 0) {
    process.stdout.write("Murmur is already configured for the selected clients.\n");
  } else {
    process.stdout.write("Configured Murmur user-level MCP and passive notifications:\n");
    for (const path of changedPaths) process.stdout.write(`  ${path}\n`);
  }
  const token: string | undefined = process.env[MURMUR_TOKEN_ENV];
  if (token === undefined || token.trim() === "") {
    process.stdout.write(
      `\nWarning: ${MURMUR_TOKEN_ENV} is not set in this process. Set it where Codex and Claude are launched.\n`,
    );
  } else {
    process.stdout.write(
      `\nAuthentication uses ${MURMUR_TOKEN_ENV}; no token was written to settings.\n`,
    );
  }
  process.stdout.write("Restart active Codex and Claude sessions to load the hooks.\n");
}

function main(): void {
  const arguments_: readonly string[] = process.argv.slice(2);
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (arguments_[0] !== "setup") {
    throw new Error(`Unknown command: ${arguments_[0] ?? ""}\n\n${HELP}`);
  }
  if (arguments_[1] === "--help" || arguments_[1] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const changedPaths: readonly string[] = setup(arguments_.slice(1));
  printSetupResult(changedPaths);
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`murmur: ${message}\n`);
    process.exitCode = 1;
  }
}
