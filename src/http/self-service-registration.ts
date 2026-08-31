import type { z } from "zod";

import type { IssuedToken, TenantSummary } from "../hosted/control-plane-contracts.js";
import {
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type SelfServiceRegistrationInput,
  SelfServiceRegistrationInputSchema,
  toIssuedTokenDto,
  toTenantSummaryDto,
} from "../hosted/contracts.js";
import {
  TenantRegistrationBusyError,
  TenantRegistrationCapacityError,
  TenantRegistrationRateLimitError,
  TenantRegistrationReplayConflictError,
  TenantSlugConflictError,
} from "../hosted/self-service-tenant-control-plane.js";
import type { RequestObservation } from "../observability/request-observation.js";
import type { HttpCapacityController } from "./http-capacity.js";
import {
  jsonResponse,
  originIsAllowed,
  parseRequestBody,
  RequestBodyTooLargeError,
} from "./http-request.js";
import { responseWithFinish } from "./response-lifecycle.js";

const MAX_REGISTRATION_BODY_BYTES: number = 4_096;
const REGISTRATION_CAPACITY_IDENTITY: string = "public-tenant-registration";

export type TenantRegistrationService = (
  slug: string,
  displayName: string,
  registrationSecret: string,
) => Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }>;

export type TenantRegistrationHandlerOptions = {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly capacity: HttpCapacityController;
  readonly maxRequestBytes: number;
  readonly rateLimitPerMinute: number;
  readonly registration: TenantRegistrationService | null;
};

function retryResponse(status: 429 | 503, error: string): Response {
  return Response.json(
    { error },
    { headers: { "cache-control": "no-store", "retry-after": "60" }, status },
  );
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const separator: number = value.indexOf(";");
  const mediaType: string = separator === -1 ? value : value.slice(0, separator);
  return mediaType.trim().toLowerCase() === "application/json";
}

function invalidRegistrationResponse(error: z.ZodError): Response {
  const fields: Set<string> = new Set<string>();
  error.issues.forEach((issue: z.core.$ZodIssue): void => {
    fields.add(issue.path.length === 0 ? "body" : issue.path.join("."));
  });
  return jsonResponse(400, {
    error: "Invalid tenant registration request",
    fields: Array.from(fields).sort(),
  });
}

function registrationFailure(error: unknown, observation: RequestObservation): Response | null {
  if (error instanceof TenantSlugConflictError) {
    observation.recordError(error);
    return jsonResponse(409, { error: error.message });
  }
  if (error instanceof TenantRegistrationReplayConflictError) {
    observation.recordError(error);
    return jsonResponse(409, { error: error.message });
  }
  if (error instanceof TenantRegistrationRateLimitError) {
    observation.recordError(error);
    return retryResponse(429, error.message);
  }
  if (
    error instanceof TenantRegistrationCapacityError ||
    error instanceof TenantRegistrationBusyError
  ) {
    observation.recordError(error);
    return retryResponse(503, error.message);
  }
  return null;
}

async function registrationInput(
  request: Request,
  maxBodyBytes: number,
  observation: RequestObservation,
): Promise<SelfServiceRegistrationInput | Response> {
  try {
    const body: unknown = await parseRequestBody(request, maxBodyBytes);
    const parsed: ReturnType<typeof SelfServiceRegistrationInputSchema.safeParse> =
      SelfServiceRegistrationInputSchema.safeParse(body);
    return parsed.success ? parsed.data : invalidRegistrationResponse(parsed.error);
  } catch (error: unknown) {
    observation.recordError(error);
    return error instanceof RequestBodyTooLargeError
      ? jsonResponse(413, { error: `Tenant registration body exceeds ${maxBodyBytes} bytes` })
      : jsonResponse(400, { error: "Tenant registration body must be valid JSON" });
  }
}

export function createTenantRegistrationHandler(
  options: TenantRegistrationHandlerOptions,
): (request: Request, observation: RequestObservation) => Promise<Response> {
  return async (request: Request, observation: RequestObservation): Promise<Response> => {
    const registration: TenantRegistrationService | null = options.registration;
    if (registration === null) return jsonResponse(404, { error: "Not found" });
    if (!originIsAllowed(request, options.allowedOrigins)) {
      observation.recordOrigin("rejected");
      return jsonResponse(403, { error: "Origin is not allowed" });
    }
    observation.recordOrigin("allowed");
    if (request.method !== "POST") {
      return new Response(null, {
        headers: { allow: "POST", "cache-control": "no-store" },
        status: 405,
      });
    }
    const contentType: string | null = request.headers.get("content-type");
    if (!isJsonContentType(contentType)) {
      return jsonResponse(415, { error: "Content-Type must be application/json" });
    }

    const releaseCapacity: (() => void) | null = options.capacity.reserveRequest(
      REGISTRATION_CAPACITY_IDENTITY,
      null,
    );
    if (releaseCapacity === null) {
      observation.recordRequestCapacity("rejected");
      return retryResponse(503, "Tenant registration capacity reached");
    }
    observation.recordRequestCapacity("allowed");
    let responseHandedOff: boolean = false;
    try {
      let response: Response;
      const maxBodyBytes: number = Math.min(MAX_REGISTRATION_BODY_BYTES, options.maxRequestBytes);
      const parsedInput: SelfServiceRegistrationInput | Response = await registrationInput(
        request,
        maxBodyBytes,
        observation,
      );
      if (parsedInput instanceof Response) {
        response = parsedInput;
      } else if (
        !options.capacity.rateLimitAllows(
          REGISTRATION_CAPACITY_IDENTITY,
          options.rateLimitPerMinute,
        )
      ) {
        observation.recordPrincipalRateLimit("rejected");
        response = retryResponse(429, "Tenant registration rate limit reached");
      } else {
        observation.recordPrincipalRateLimit("allowed");
        const input: SelfServiceRegistrationInput = parsedInput;
        try {
          const created: { readonly tenant: TenantSummary; readonly token: IssuedToken } =
            await registration(input.slug, input.display_name, input.registration_secret);
          const output: CreateTenantOutput = CreateTenantOutputSchema.parse({
            tenant: toTenantSummaryDto(created.tenant),
            token: toIssuedTokenDto(created.token),
          });
          response = jsonResponse(201, output);
        } catch (error: unknown) {
          const knownFailure: Response | null = registrationFailure(error, observation);
          if (knownFailure === null) throw error;
          response = knownFailure;
        }
      }
      const tracked: Response = responseWithFinish(response, releaseCapacity);
      responseHandedOff = true;
      return tracked;
    } finally {
      if (!responseHandedOff) releaseCapacity();
    }
  };
}
