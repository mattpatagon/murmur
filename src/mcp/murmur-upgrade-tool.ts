import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  CheckForUpgradesInputSchema,
  CheckForUpgradesOutputSchema,
} from "../domain/upgrade-contracts.js";
import type { MurmurUpgradeChecker } from "./murmur-upgrade-checker.js";
import { toolDefinition } from "./tool-definition.js";
import { toolResult } from "./murmur-tool-results.js";

export const CHECK_FOR_UPGRADES_TOOL_NAME: string = "check_for_upgrades";

export function upgradeToolDefinition(): Tool {
  return toolDefinition(
    CHECK_FOR_UPGRADES_TOOL_NAME,
    "Check for Murmur upgrades",
    "Compare this MCP endpoint's Murmur version with official main and return brief, revision-pinned upgrade instructions.",
    CheckForUpgradesInputSchema,
    CheckForUpgradesOutputSchema,
    {
      destructiveHint: false,
      idempotentHint: true,
      readOnlyHint: true,
      title: "Check for Murmur upgrades",
    },
  );
}

export async function callUpgradeTool(
  name: string,
  argumentsValue: unknown,
  checker: MurmurUpgradeChecker,
): Promise<CallToolResult | null> {
  if (name !== CHECK_FOR_UPGRADES_TOOL_NAME) return null;
  CheckForUpgradesInputSchema.parse(argumentsValue);
  return toolResult(await checker.checkForUpgrades());
}
