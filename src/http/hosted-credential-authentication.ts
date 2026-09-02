import type { HostedAuthenticator } from "../hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../hosted/control-plane.js";
import { hashTokenSecret } from "../hosted/token-secret.js";
import type { RequestObservation } from "../observability/request-observation.js";
import { logSafeError } from "../safe-errors.js";
import type { HttpCapacityController } from "./http-capacity.js";

export type HostedAuthenticationResult =
  | { readonly kind: "authenticated"; readonly principal: HostedPrincipal }
  | { readonly kind: "capacity" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export async function authenticateHostedCredential(
  token: string,
  authenticator: HostedAuthenticator,
  capacity: HttpCapacityController,
  observation: RequestObservation,
): Promise<HostedAuthenticationResult> {
  const registeredAdmission: CredentialAdmission | null = authenticator.credentialAdmission(token);
  const admittedTenantKey: string | null =
    registeredAdmission === null ? null : registeredAdmission.tenantKey;
  const admissionKey: string =
    registeredAdmission === null
      ? hashTokenSecret(token).toString("base64url")
      : registeredAdmission.key;
  const knownCredential: boolean = registeredAdmission !== null;
  observation.recordCredential(knownCredential ? "known" : "unknown");
  const releaseAuthenticationCapacity: (() => void) | null = await capacity.reserveAuthentication(
    admissionKey,
    admittedTenantKey,
    knownCredential,
  );
  if (releaseAuthenticationCapacity === null) {
    observation.recordAuthenticationCapacity("rejected");
    return { kind: "capacity" };
  }
  observation.recordAuthenticationCapacity("allowed");
  let principal: HostedPrincipal | null;
  try {
    principal = await authenticator.authenticate(token);
  } catch (error: unknown) {
    observation.recordAuthentication("backend_error");
    observation.recordError(error);
    logSafeError("Murmur authentication backend error", error);
    return { kind: "unavailable" };
  } finally {
    releaseAuthenticationCapacity();
  }
  if (principal === null) {
    observation.recordAuthentication("invalid");
    return { kind: "invalid" };
  }
  observation.recordAuthentication("authenticated");
  observation.recordPrincipal(principal);
  return { kind: "authenticated", principal };
}
