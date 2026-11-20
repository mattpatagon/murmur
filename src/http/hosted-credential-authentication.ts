import type { HostedAuthenticator } from "../hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../hosted/control-plane.js";
import { hashTokenSecret } from "../hosted/token-secret.js";
import type { RequestObservation } from "../observability/request-observation.js";
import { logSafeError } from "../safe-errors.js";
import type {
  AuthenticationCapacityReservation,
  AuthenticationCapacityScope,
  HttpCapacityController,
} from "./http-capacity.js";

export type HostedAuthenticationResult =
  | { readonly kind: "authenticated"; readonly principal: HostedPrincipal }
  | { readonly kind: "capacity"; readonly scope: AuthenticationCapacityScope }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export async function authenticateHostedCredential(
  token: string,
  authenticator: HostedAuthenticator,
  capacity: HttpCapacityController,
  observation: RequestObservation,
  signal: AbortSignal,
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
  const reservation: AuthenticationCapacityReservation = await capacity.reserveAuthentication(
    admissionKey,
    admittedTenantKey,
    knownCredential,
    signal,
  );
  if (reservation.kind === "cancelled") return { kind: "cancelled" };
  if (reservation.kind === "rejected") {
    observation.recordAuthenticationCapacity("rejected");
    observation.recordAuthenticationCapacityScope(reservation.scope);
    return { kind: "capacity", scope: reservation.scope };
  }
  if (signal.aborted) {
    reservation.release();
    return { kind: "cancelled" };
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
    reservation.release();
  }
  if (signal.aborted) return { kind: "cancelled" };
  if (principal === null) {
    observation.recordAuthentication("invalid");
    return { kind: "invalid" };
  }
  observation.recordAuthentication("authenticated");
  observation.recordPrincipal(principal);
  return { kind: "authenticated", principal };
}
