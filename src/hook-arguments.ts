import { isAbsolute } from "node:path";

import type { MurmurClient } from "./setup/user-configuration.js";

export type HookArguments = {
  readonly client: MurmurClient;
  readonly e2ee: boolean;
  readonly vaultPath: string | null;
};

const HOOK_USAGE: string =
  "Usage: murmur-hook --client <claude|codex|omp> [--e2ee] [--vault-path PATH]";

export function parseHookArguments(arguments_: readonly string[]): HookArguments {
  let client: MurmurClient | null = null;
  let e2ee: boolean = false;
  let vaultPath: string | null = null;
  for (let index: number = 0; index < arguments_.length; index += 1) {
    const argument: string | undefined = arguments_[index];
    if (argument === "--e2ee") {
      e2ee = true;
      continue;
    }
    if (argument === "--client") {
      const value: string | undefined = arguments_[index + 1];
      if (value !== "claude" && value !== "codex" && value !== "omp") throw new Error(HOOK_USAGE);
      client = value;
      index += 1;
      continue;
    }
    if (argument === "--vault-path") {
      const value: string | undefined = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(HOOK_USAGE);
      vaultPath = value;
      index += 1;
      continue;
    }
    throw new Error(HOOK_USAGE);
  }
  if (client === null || (vaultPath !== null && (!e2ee || !isAbsolute(vaultPath)))) {
    throw new Error(HOOK_USAGE);
  }
  return { client, e2ee, vaultPath };
}
