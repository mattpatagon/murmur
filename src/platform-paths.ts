import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export function environmentPath(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value: string | undefined = environment[name];
  return value === undefined || value.trim() === "" ? null : value;
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed: number = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function userHomeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configuredHome: string | null = environmentPath(
    environment,
    platform === "win32" ? "USERPROFILE" : "HOME",
  );
  return configuredHome ?? homedir();
}

export function defaultHookCacheDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const xdgCacheHome: string | null = environmentPath(environment, "XDG_CACHE_HOME");
  if (xdgCacheHome !== null) return join(xdgCacheHome, "murmur", "hooks");
  if (platform === "win32") {
    const localAppData: string | null = environmentPath(environment, "LOCALAPPDATA");
    if (localAppData !== null) return join(localAppData, "murmur", "hooks");
    return join(userHomeDirectory(environment, platform), "AppData", "Local", "murmur", "hooks");
  }
  return join(userHomeDirectory(environment, platform), ".cache", "murmur", "hooks");
}
