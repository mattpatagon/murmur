#!/usr/bin/env bun

import { existsSync } from "node:fs";
import process from "node:process";
import { runAdminCli } from "./admin/terminal-client.js";

import { runE2eeCli } from "./e2ee/cli.js";
import {
  DEFAULT_MURMUR_URL,
  MURMUR_TOKEN_ENV,
  PI_ADAPTER_NOTE,
  supportsLifecycleHooks,
} from "./setup/client-configuration.js";
import {
  parseSetupArguments,
  type SetupArguments,
  setupIncludesPi,
} from "./setup/setup-arguments.js";
import { runSignupCli } from "./setup/signup.js";
import { installUserConfiguration } from "./setup/user-configuration.js";

export type SetupAction = (arguments_: readonly string[]) => readonly string[];

const HELP: string = `Murmur user-level setup

Usage:
  murmur setup --user [--claude] [--codex] [--fx] [--opencode] [--cursor] [--pi] [--e2ee] [--replace] [--url URL]
  murmur signup --slug ORGANIZATION --name NAME [--credentials-directory ABSOLUTE_DIRECTORY] [--url URL]
  murmur e2ee <command> [options]
  murmur admin TOOL [--arguments-file PATH] [--url URL]

The default is to configure Claude Code, Codex, fx, OpenCode, Cursor, and Pi. The
command adds the remote Murmur MCP server to each selected host. Claude Code and
Codex also receive passive SessionStart, UserPromptSubmit, PostToolUse, Stop, and
SessionEnd hooks. fx receives machine-wide Murmur coordination instructions and
supports MCP resource subscriptions plus explicit lifecycle calls. Hooks and
notifications do not wake an idle agent.

Options:
  --codex               Configure Codex
  --claude              Configure Claude Code
  --fx                  Configure fx
  --opencode            Configure OpenCode
  --cursor              Configure Cursor
  --pi                  Configure Pi through pi-mcp-adapter
  --e2ee                Use the local end-to-end encryption proxy
  --replace             Replace a conflicting Murmur MCP entry
  --url URL             MCP endpoint (default: ${DEFAULT_MURMUR_URL})
  --vault-path PATH     Absolute E2E vault path for both proxy and hooks
  --user                Required acknowledgement of user-level scope
  -h, --help            Show this help

Authentication:
  Set ${MURMUR_TOKEN_ENV} in the environment that launches the selected clients.
  The token is referenced by name and is never copied into client settings.
`;

function resolveProxyExecutable(configured: string | null): string {
  if (configured !== null) {
    if (!existsSync(configured)) throw new Error(`E2E proxy executable not found: ${configured}`);
    return configured;
  }
  const executable: string | null = Bun.which("murmur-e2ee-proxy", {
    PATH: process.env["PATH"] ?? "",
  });
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
  const executable: string | null = Bun.which("murmur-hook", {
    PATH: process.env["PATH"] ?? "",
  });
  if (executable === null) {
    throw new Error(
      "murmur-hook is not on PATH. Install Murmur globally, then run murmur setup again.",
    );
  }
  return executable;
}

export function setup(arguments_: readonly string[]): readonly string[] {
  const parsed: SetupArguments = parseSetupArguments(arguments_);
  const hookExecutable: string | undefined = parsed.clients.some(supportsLifecycleHooks)
    ? resolveHookExecutable(parsed.hookExecutable)
    : undefined;
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
  piAdapterRequired: boolean = false,
): string {
  let output: string;
  if (changedPaths.length === 0) {
    output = "Murmur is already configured for the selected clients.\n";
  } else {
    output = "Configured Murmur user-level MCP configuration:\n";
    for (const path of changedPaths) output += `  ${path}\n`;
  }
  if (tokenConfigured) {
    output += `\nAuthentication uses ${MURMUR_TOKEN_ENV}; no token was written to settings.\n`;
  } else {
    output +=
      `\nWarning: ${MURMUR_TOKEN_ENV} is not set in this process. ` +
      "Set it where the selected clients are launched.\n";
  }
  if (piAdapterRequired) output += `\n${PI_ADAPTER_NOTE}\n`;
  return `${output}Restart active client sessions to load the MCP configuration. Claude Code and Codex also load passive hooks; fx loads managed coordination instructions and supports MCP resource subscriptions with wait_for_messages as its active-turn fallback.\n`;
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
  return formatSetupResult(
    changedPaths,
    token !== undefined && token.trim() !== "",
    setupIncludesPi(arguments_.slice(1)),
  );
}

export async function runCliAsync(
  arguments_: readonly string[],
  setupAction: SetupAction = setup,
  token: string | undefined = process.env[MURMUR_TOKEN_ENV],
): Promise<string> {
  if (arguments_[0] === "e2ee") return await runE2eeCli(arguments_.slice(1));
  if (arguments_[0] === "signup") return await runSignupCli(arguments_.slice(1));
  if (arguments_[0] === "admin") return await runAdminCli(arguments_.slice(1));
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
