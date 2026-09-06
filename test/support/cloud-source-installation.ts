import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE_INPUTS: readonly string[] = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "patches",
  "src",
];

export function prepareCloudSourceInstallation(sourceRoot: string, installationRoot: string): void {
  mkdirSync(installationRoot, { recursive: true });
  for (const input of SOURCE_INPUTS) {
    cpSync(join(sourceRoot, input), join(installationRoot, input), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }
}
