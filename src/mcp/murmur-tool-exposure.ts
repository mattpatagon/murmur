import type { HostedPrincipal } from "../hosted/control-plane.js";
import type { E2eeEntitlementRecord } from "../hosted/e2ee-entitlement.js";

export type { E2eeEntitlementRecord } from "../hosted/e2ee-entitlement.js";

export type ToolExposure = {
  readonly bootstrapEnabled: boolean;
  readonly e2eeEntitlement?: E2eeEntitlementRecord | null | undefined;
  readonly legacyAdoptionEnabled: boolean;
  readonly orchestrationEnabled?: boolean | undefined;
  readonly principal: HostedPrincipal | null;
  readonly tenantOnboardingEnabled: boolean;
};
