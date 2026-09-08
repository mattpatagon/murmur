import { isAbsolute } from "node:path";

import {
  DEFAULT_MURMUR_URL,
  DEFAULT_SETUP_CLIENTS,
  type SetupClient,
} from "./client-configuration.js";

export type SetupArguments = {
  readonly clients: readonly SetupClient[];
  readonly e2ee: boolean;
  readonly hookExecutable: string | null;
  readonly proxyExecutable: string | null;
  readonly replace: boolean;
  readonly url: string;
  readonly vaultPath: string | null;
};

const CLIENT_OPTIONS: readonly string[] = [
  "--claude",
  "--codex",
  "--cursor",
  "--fx",
  "--omp",
  "--opencode",
  "--pi",
];

function nextArgument(arguments_: readonly string[], index: number, option: string): string {
  const value: string | undefined = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseSetupArguments(arguments_: readonly string[]): SetupArguments {
  const clients: SetupClient[] = [];
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
      case "--cursor":
        clients.push("cursor");
        break;
      case "--e2ee":
        e2ee = true;
        break;
      case "--fx":
        clients.push("fx");
        break;
      case "--hook-executable":
        hookExecutable = nextArgument(arguments_, index, argument);
        index += 1;
        break;
      case "--omp":
        clients.push("omp");
        break;
      case "--opencode":
        clients.push("opencode");
        break;
      case "--pi":
        clients.push("pi");
        break;
      case "--proxy-executable":
        proxyExecutable = nextArgument(arguments_, index, argument);
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
    clients: clients.length === 0 ? DEFAULT_SETUP_CLIENTS : [...new Set(clients)],
    e2ee,
    hookExecutable,
    proxyExecutable,
    replace,
    url: parsedUrl.toString(),
    vaultPath,
  };
}

export function setupIncludesPi(arguments_: readonly string[]): boolean {
  const selected: readonly string[] = arguments_.filter((argument: string): boolean =>
    CLIENT_OPTIONS.includes(argument),
  );
  return selected.length === 0 || selected.includes("--pi");
}
