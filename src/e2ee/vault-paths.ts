import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import {
  environmentPath,
  type PathJoin,
  pathJoinForPlatform,
  userHomeDirectory,
} from "../platform-paths.js";

export function defaultE2eeVaultPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const join: PathJoin = pathJoinForPlatform(platform);
  if (platform === "win32") {
    const localAppData: string | null = environmentPath(environment, "LOCALAPPDATA");
    const base: string =
      localAppData === null
        ? join(userHomeDirectory(environment, platform), "AppData", "Local")
        : localAppData;
    return join(base, "murmur", "e2ee-vault.sqlite");
  }
  if (platform === "darwin") {
    return join(
      userHomeDirectory(environment, platform),
      "Library",
      "Application Support",
      "murmur",
      "e2ee-vault.sqlite",
    );
  }
  const xdgData: string | null = environmentPath(environment, "XDG_DATA_HOME");
  const base: string =
    xdgData === null ? join(userHomeDirectory(environment, platform), ".local", "share") : xdgData;
  return join(base, "murmur", "e2ee-vault.sqlite");
}

export function prepareVaultDirectory(path: string, platform: NodeJS.Platform): void {
  if (path === ":memory:") return;
  const directory: string = dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (platform === "win32") {
    runIcacls(windowsVaultDirectoryAclArguments(directory));
    runIcacls([directory, "/verify"]);
    return;
  }
  chmodSync(directory, 0o700);
}

export function windowsVaultAclArguments(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const username: string | undefined = environment["USERNAME"];
  if (username === undefined || !/^[A-Za-z0-9._ -]{1,128}$/u.test(username)) {
    throw new Error("Windows user identity is unavailable for E2E vault protection");
  }
  const domain: string | undefined = environment["USERDOMAIN"];
  if (domain !== undefined && !/^[A-Za-z0-9._ -]{1,128}$/u.test(domain)) {
    throw new Error("Windows user domain is invalid for E2E vault protection");
  }
  const account: string = domain === undefined ? username : `${domain}\\${username}`;
  return [path, "/inheritance:r", "/grant:r", `${account}:(F)`];
}

export function windowsVaultDirectoryAclArguments(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const fileArguments: readonly string[] = windowsVaultAclArguments(path, environment);
  const accountGrant: string | undefined = fileArguments[3];
  if (accountGrant === undefined) throw new Error("Windows E2E vault ACL is incomplete");
  return [path, "/inheritance:r", "/grant:r", accountGrant.replace(":(F)", ":(OI)(CI)(F)")];
}

function runIcacls(arguments_: readonly string[]): void {
  const result: SpawnSyncReturns<string> = spawnSync("icacls.exe", arguments_, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Windows could not apply owner-only E2E vault permissions");
  }
}

export function protectVaultFile(path: string, platform: NodeJS.Platform): void {
  if (path === ":memory:") return;
  const files: readonly string[] = [path, `${path}-wal`, `${path}-shm`];
  for (const file of files) {
    if (!existsSync(file)) continue;
    if (platform === "win32") {
      runIcacls(windowsVaultAclArguments(file));
      runIcacls([file, "/verify"]);
    } else {
      chmodSync(file, 0o600);
      const mode: number = statSync(file).mode & 0o777;
      if (mode !== 0o600) throw new Error("E2E vault permissions are not owner-only");
    }
  }
}
