import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AgentId, type TenantId } from "../domain/value-objects.js";
import type { HostedControlPlane, TenantPrincipal } from "../hosted/control-plane.js";
import {
  type E2eeEntitlementOutput,
  E2eeEntitlementOutputSchema,
  GetE2eeEntitlementInputSchema,
  type ResetE2eeIdentityInput,
  ResetE2eeIdentityInputSchema,
  type ResetE2eeIdentityOutput,
  ResetE2eeIdentityOutputSchema,
  type TransitionE2eeInput,
  TransitionE2eeInputSchema,
  type TransitionE2eeOutput,
  TransitionE2eeOutputSchema,
  toE2eeEntitlementDto,
} from "../hosted/e2ee-admin-contracts.js";
import type { E2eeEntitlementRecord, E2eeTransitionResult } from "../hosted/e2ee-entitlement.js";
import { toolResult } from "./murmur-tool-results.js";

export async function callE2eeAdminTool(
  name: string,
  argumentsValue: unknown,
  principal: TenantPrincipal,
  controlPlane: HostedControlPlane,
  onStateChanged: ((tenantId: TenantId) => Promise<void>) | null,
): Promise<CallToolResult | null> {
  switch (name) {
    case "get_e2ee_entitlement": {
      GetE2eeEntitlementInputSchema.parse(argumentsValue);
      const entitlement: E2eeEntitlementRecord = await controlPlane.getE2eeEntitlement(principal);
      const output: E2eeEntitlementOutput = E2eeEntitlementOutputSchema.parse({
        entitlement: toE2eeEntitlementDto(entitlement),
      });
      return toolResult(output);
    }
    case "transition_e2ee": {
      const input: TransitionE2eeInput = TransitionE2eeInputSchema.parse(argumentsValue);
      const transitioned: E2eeTransitionResult = await controlPlane.transitionE2ee(
        principal,
        input.action,
        input.expected_state,
        input.trust_policy_version ?? null,
      );
      if (transitioned.changed && onStateChanged !== null) {
        await onStateChanged(principal.tenantId);
      }
      const output: TransitionE2eeOutput = TransitionE2eeOutputSchema.parse({
        changed: transitioned.changed,
        entitlement: toE2eeEntitlementDto(transitioned.entitlement),
      });
      return toolResult(output);
    }
    case "reset_e2ee_identity": {
      const input: ResetE2eeIdentityInput = ResetE2eeIdentityInputSchema.parse(argumentsValue);
      const reset: boolean = await controlPlane.resetE2eeIdentity(
        principal,
        AgentId.parse(input.agent_id),
        input.expected_root_key_id,
        input.reason,
      );
      if (reset && onStateChanged !== null) await onStateChanged(principal.tenantId);
      const output: ResetE2eeIdentityOutput = ResetE2eeIdentityOutputSchema.parse({ reset });
      return toolResult(output);
    }
    default:
      return null;
  }
}
