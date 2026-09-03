import { existsSync } from "node:fs";
import process from "node:process";

import { LocalE2eeVault } from "./local-vault.js";
import { defaultE2eeVaultPath } from "./vault-paths.js";

export function retireConfiguredLocalAgentKey(
  agentId: string,
  retiredAt: string,
  environment: NodeJS.ProcessEnv,
  configuredPath?: string | undefined,
): void {
  const path: string = configuredPath ?? defaultE2eeVaultPath(environment, process.platform);
  if (!existsSync(path)) return;
  const vault: LocalE2eeVault = new LocalE2eeVault(path, process.platform);
  try {
    vault.keys.retireAgent(agentId, retiredAt);
  } finally {
    vault.close();
  }
}
