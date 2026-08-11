import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CreateTokenInputSchema,
  IssuedTokenOutputSchema,
  ListTokensInputSchema,
  ListTokensOutputSchema,
  RevokeTokenInputSchema,
  RevokeTokenOutputSchema,
} from "../hosted/contracts.js";
import {
  E2eeEntitlementOutputSchema,
  GetE2eeEntitlementInputSchema,
  ResetE2eeIdentityInputSchema,
  ResetE2eeIdentityOutputSchema,
  TransitionE2eeInputSchema,
  TransitionE2eeOutputSchema,
} from "../hosted/e2ee-admin-contracts.js";
import { toolDefinition } from "./tool-definition.js";

export function tenantAdminTools(): Tool[] {
  return [
    toolDefinition(
      "create_access_token",
      "Create tenant access token",
      "Create an agent or tenant-administrator token for the authenticated tenant. The secret is returned exactly once; store it securely.",
      CreateTokenInputSchema,
      IssuedTokenOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
        title: "Create tenant access token",
      },
    ),
    toolDefinition(
      "list_access_tokens",
      "List tenant access tokens",
      "List one cursor-paginated page of token identifiers and lifecycle timestamps for the authenticated tenant. Token secrets are never returned.",
      ListTokensInputSchema,
      ListTokensOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "List tenant access tokens",
      },
    ),
    toolDefinition(
      "revoke_access_token",
      "Revoke tenant access token",
      "Immediately revoke one access token in the authenticated tenant and close its live MCP sessions.",
      RevokeTokenInputSchema,
      RevokeTokenOutputSchema,
      {
        destructiveHint: true,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Revoke tenant access token",
      },
    ),
    toolDefinition(
      "get_e2ee_entitlement",
      "Read tenant E2E state",
      "Read the authenticated tenant's server-derived encryption state and migration prerequisites.",
      GetE2eeEntitlementInputSchema,
      E2eeEntitlementOutputSchema,
      {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: true,
        title: "Read tenant E2E state",
      },
    ),
    toolDefinition(
      "transition_e2ee",
      "Transition tenant E2E state",
      "Advance or safely roll back the authenticated tenant's audited E2E cutover state. Every transition closes existing tenant sessions so clients must reload the authoritative tool matrix.",
      TransitionE2eeInputSchema,
      TransitionE2eeOutputSchema,
      {
        destructiveHint: true,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Transition tenant E2E state",
      },
    ),
    toolDefinition(
      "reset_e2ee_identity",
      "Reset agent E2E identity",
      "Audited recovery for a lost or replaced endpoint root. Requires the exact current root fingerprint and refuses while encryption work is active.",
      ResetE2eeIdentityInputSchema,
      ResetE2eeIdentityOutputSchema,
      {
        destructiveHint: true,
        idempotentHint: true,
        readOnlyHint: false,
        title: "Reset agent E2E identity",
      },
    ),
  ];
}
