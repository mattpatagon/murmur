import { FOUNDING_TENANT_ID } from "../domain/value-objects.js";
import { credentialAdmissionKey } from "../hosted/token-secret.js";

const OWNER_ADMISSION_KEY: string = credentialAdmissionKey(FOUNDING_TENANT_ID);

// Callers supply an authenticated tenant or an authoritative credential-admission hint.
export function isOwnerTenant(enabled: boolean, tenantId: string | null): boolean {
  return enabled && tenantId === FOUNDING_TENANT_ID;
}

export function isOwnerAuthentication(
  enabled: boolean,
  tenantKey: string | null,
  knownCredential: boolean,
): boolean {
  return enabled && knownCredential && tenantKey === OWNER_ADMISSION_KEY;
}

export function ownerReservedSlots(maximum: number): number {
  return Math.max(1, Math.floor(maximum / 4));
}

export function admittedGlobalLimit(maximum: number, enabled: boolean, owner: boolean): number {
  return enabled && !owner ? maximum - ownerReservedSlots(maximum) : maximum;
}

export function admittedScopeLimit(maximum: number, current: number, owner: boolean): number {
  return owner ? maximum : current;
}
