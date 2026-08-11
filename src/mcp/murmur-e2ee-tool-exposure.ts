import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { encryptedWireToolDefinitions } from "../e2ee/wire-tool-definitions.js";
import { type E2eeEntitlementRecord, tenantDataToolNames } from "../hosted/e2ee-entitlement.js";

export function entitledDataTools(
  entitlement: E2eeEntitlementRecord,
  plaintextTools: readonly Tool[],
  orchestrationClaimEnabled: boolean,
): Tool[] {
  const allowedNames: ReadonlySet<string> = new Set<string>(tenantDataToolNames(entitlement));
  const selected: Map<string, Tool> = new Map<string, Tool>();
  for (const tool of [...plaintextTools, ...encryptedWireToolDefinitions()]) {
    const orchestrationClaimUnavailable: boolean =
      tool.name === "claim_orchestrator_prekey" && !orchestrationClaimEnabled;
    if (allowedNames.has(tool.name) && !orchestrationClaimUnavailable) {
      selected.set(tool.name, tool);
    }
  }
  return Array.from(selected.values());
}
