import { expect, test } from "bun:test";

import { PersonalId } from "../src/domain/orchestration.js";
import { Instant, TenantId } from "../src/domain/value-objects.js";
import type { IssuedToken, TenantSummary } from "../src/hosted/control-plane-contracts.js";
import {
  TenantRegistrationBusyError,
  TenantRegistrationCapacityError,
  TenantRegistrationRateLimitError,
  TenantRegistrationReplayConflictError,
  TenantSlugConflictError,
} from "../src/hosted/self-service-tenant-control-plane.js";
import { HttpCapacityController } from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";
import { createHttpRequestHandler } from "../src/http/http-router.js";
import {
  createTenantRegistrationHandler,
  type TenantRegistrationService,
} from "../src/http/self-service-registration.js";
import {
  createHttpObservability,
  type HttpObservability,
  type RequestObservation,
} from "../src/observability/request-observation.js";
import { StructuredLogger } from "../src/observability/structured-logger.js";
import { createTelemetry } from "../src/observability/telemetry.js";

const REGISTRATION_URL: string = "https://murmur.example/v1/tenants";
const TENANT_ID: string = "41000000-0000-4000-8000-000000000001";
const TOKEN_ID: string = "42000000-0000-4000-8000-000000000001";
const TOKEN_SECRET: string = `mur_tenant01_${"a".repeat(43)}`;
const REGISTRATION_SECRET: string = "r".repeat(43);

function createdTenant(
  slug: string,
  displayName: string,
): {
  readonly tenant: TenantSummary;
  readonly token: IssuedToken;
} {
  return {
    tenant: {
      createdAt: Instant.parse("2026-08-31T12:00:00.000Z"),
      displayName,
      slug,
      status: "active",
      suspendedAt: null,
      tenantId: TenantId.parse(TENANT_ID),
    },
    token: {
      agentId: null,
      expiresAt: null,
      keyId: "tenant01",
      machineName: null,
      name: "Initial tenant administrator",
      personalId: PersonalId.parse(TOKEN_ID),
      repositoryName: null,
      role: "tenant_admin",
      secret: TOKEN_SECRET,
      tenantId: TenantId.parse(TENANT_ID),
      tokenId: TOKEN_ID,
    },
  };
}

function observability(): HttpObservability {
  const environment: NodeJS.ProcessEnv = { MURMUR_LOG_LEVEL: "off" };
  return createHttpObservability(new StructuredLogger(environment), createTelemetry(environment));
}

function registrationHandler(
  registration: TenantRegistrationService | null,
  environment: NodeJS.ProcessEnv = {},
  allowedOrigins: ReadonlySet<string> = new Set<string>(),
): (request: Request) => Promise<Response> {
  const observations: HttpObservability = observability();
  const handler: (request: Request, observation: RequestObservation) => Promise<Response> =
    createTenantRegistrationHandler({
      allowedOrigins,
      capacity: new HttpCapacityController(parseHttpServerConfig(environment)),
      maxRequestBytes: parseHttpServerConfig(environment).maxRequestBytes,
      rateLimitPerMinute: parseHttpServerConfig(environment).registrationRateLimitPerMinute,
      registration,
    });
  return async (request: Request): Promise<Response> =>
    await handler(request, observations.observe(request));
}

function postRegistration(
  handler: (request: Request) => Promise<Response>,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> {
  return handler(new Request(REGISTRATION_URL, { body, headers, method: "POST" }));
}

test("self-service registration returns a replay-safe tenant administrator credential", async (): Promise<void> => {
  const calls: Array<{
    readonly displayName: string;
    readonly registrationSecret: string;
    readonly slug: string;
  }> = [];
  const handler: (request: Request) => Promise<Response> = registrationHandler(
    async (
      slug: string,
      displayName: string,
      registrationSecret: string,
    ): ReturnType<TenantRegistrationService> => {
      calls.push({ displayName, registrationSecret, slug });
      return createdTenant(slug, displayName);
    },
  );
  const response: Response = await postRegistration(
    handler,
    JSON.stringify({
      display_name: "Example Organization",
      registration_secret: REGISTRATION_SECRET,
      slug: "example-org",
    }),
  );

  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    tenant: {
      created_at: "2026-08-31T12:00:00.000Z",
      display_name: "Example Organization",
      slug: "example-org",
      status: "active",
      suspended_at: null,
      tenant_id: TENANT_ID,
    },
    token: {
      agent_id: null,
      expires_at: null,
      key_id: "tenant01",
      name: "Initial tenant administrator",
      personal_id: TOKEN_ID,
      repository: null,
      role: "tenant_admin",
      secret: TOKEN_SECRET,
      tenant_id: TENANT_ID,
      token_id: TOKEN_ID,
    },
  });
  expect(calls).toEqual([
    {
      displayName: "Example Organization",
      registrationSecret: REGISTRATION_SECRET,
      slug: "example-org",
    },
  ]);
});

test("registration is hidden when hosted self-service is unavailable", async (): Promise<void> => {
  const handler: (request: Request) => Promise<Response> = registrationHandler(null);
  const response: Response = await postRegistration(handler, "{}");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found" });
});

test("registration validates method, origin, media type, JSON, shape, and body size", async (): Promise<void> => {
  const service: TenantRegistrationService = async (
    slug: string,
    displayName: string,
    _registrationSecret: string,
  ): ReturnType<TenantRegistrationService> => createdTenant(slug, displayName);
  const allowedHandler: (request: Request) => Promise<Response> = registrationHandler(
    service,
    {},
    new Set<string>(["https://allowed.example"]),
  );
  const rejectedOrigin: Response = await postRegistration(allowedHandler, "{}", {
    "content-type": "application/json",
    origin: "https://rejected.example",
  });
  expect(rejectedOrigin.status).toBe(403);
  await rejectedOrigin.arrayBuffer();

  const handler: (request: Request) => Promise<Response> = registrationHandler(service, {
    MURMUR_MAX_REQUEST_BYTES: "64",
  });
  const wrongMethod: Response = await handler(new Request(REGISTRATION_URL));
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("allow")).toBe("POST");
  await wrongMethod.arrayBuffer();

  const wrongMediaType: Response = await postRegistration(handler, "{}", {
    "content-type": "text/plain",
  });
  expect(wrongMediaType.status).toBe(415);
  await wrongMediaType.arrayBuffer();

  const lookalikeMediaType: Response = await postRegistration(handler, "{}", {
    "content-type": "application/jsonp",
  });
  expect(lookalikeMediaType.status).toBe(415);
  await lookalikeMediaType.arrayBuffer();

  const malformed: Response = await postRegistration(handler, "{");
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({
    error: "Tenant registration body must be valid JSON",
  });

  const invalid: Response = await postRegistration(
    handler,
    JSON.stringify({ display_name: "", extra: true, slug: "INVALID" }),
  );
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({
    error: "Invalid tenant registration request",
    fields: ["body", "display_name", "registration_secret", "slug"],
  });

  const oversized: Response = await postRegistration(
    handler,
    JSON.stringify({ display_name: "A".repeat(100), slug: "large-org" }),
  );
  expect(oversized.status).toBe(413);
  await oversized.arrayBuffer();
});

test("registration maps slug, database rate, capacity, and lock failures safely", async (): Promise<void> => {
  const cases: ReadonlyArray<readonly [Error, number, string]> = [
    [new TenantSlugConflictError(), 409, "Tenant slug is already registered"],
    [
      new TenantRegistrationReplayConflictError(),
      409,
      "Registration secret was already used with different tenant details",
    ],
    [new TenantRegistrationRateLimitError(), 429, "Tenant registration rate limit reached"],
    [new TenantRegistrationCapacityError(), 503, "Tenant registration capacity reached"],
    [new TenantRegistrationBusyError(), 503, "Tenant registration is temporarily busy"],
  ];
  for (const scenario of cases) {
    const failure: Error = scenario[0];
    const handler: (request: Request) => Promise<Response> = registrationHandler(
      async (
        _slug: string,
        _displayName: string,
        _registrationSecret: string,
      ): ReturnType<TenantRegistrationService> => {
        throw failure;
      },
    );
    const response: Response = await postRegistration(
      handler,
      JSON.stringify({
        display_name: "Example",
        registration_secret: REGISTRATION_SECRET,
        slug: "example-org",
      }),
    );
    expect(response.status).toBe(scenario[1]);
    expect(await response.json()).toEqual({ error: scenario[2] });
  }
});

test("registration rate limiting applies to valid requests before database work", async (): Promise<void> => {
  let calls: number = 0;
  const handler: (request: Request) => Promise<Response> = registrationHandler(
    async (
      slug: string,
      displayName: string,
      _registrationSecret: string,
    ): ReturnType<TenantRegistrationService> => {
      calls += 1;
      return createdTenant(slug, displayName);
    },
    { MURMUR_REGISTRATION_RATE_LIMIT_PER_MINUTE: "1" },
  );
  const invalid: Response = await postRegistration(handler, "{}");
  expect(invalid.status).toBe(400);
  await invalid.arrayBuffer();
  const body: string = JSON.stringify({
    display_name: "Example",
    registration_secret: REGISTRATION_SECRET,
    slug: "example-org",
  });
  const first: Response = await postRegistration(handler, body);
  expect(first.status).toBe(201);
  await first.arrayBuffer();
  const second: Response = await postRegistration(handler, body);
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe("60");
  await second.arrayBuffer();
  expect(calls).toBe(1);
});

test("registration capacity rejects concurrent responses and releases after completion", async (): Promise<void> => {
  const handler: (request: Request) => Promise<Response> = registrationHandler(
    async (
      slug: string,
      displayName: string,
      _registrationSecret: string,
    ): ReturnType<TenantRegistrationService> => createdTenant(slug, displayName),
    { MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1" },
  );
  const body: string = JSON.stringify({
    display_name: "Example",
    registration_secret: REGISTRATION_SECRET,
    slug: "example-org",
  });
  const first: Response = await postRegistration(handler, body);
  expect(first.status).toBe(201);
  const saturated: Response = await postRegistration(handler, body);
  expect(saturated.status).toBe(503);
  expect(saturated.headers.get("retry-after")).toBe("60");
  await saturated.arrayBuffer();
  await first.arrayBuffer();
  const released: Response = await postRegistration(handler, body);
  expect(released.status).toBe(201);
  await released.arrayBuffer();
});

test("registration failures are sanitized and release request capacity", async (): Promise<void> => {
  const environment: NodeJS.ProcessEnv = { MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "1" };
  const observations: HttpObservability = observability();
  let fail: boolean = true;
  const registration: TenantRegistrationService = async (
    slug: string,
    displayName: string,
    _registrationSecret: string,
  ): ReturnType<TenantRegistrationService> => {
    if (fail) throw new Error("Authorization: Bearer must-not-leak");
    return createdTenant(slug, displayName);
  };
  const registrationRoute: (
    request: Request,
    observation: RequestObservation,
  ) => Promise<Response> = createTenantRegistrationHandler({
    allowedOrigins: new Set<string>(),
    capacity: new HttpCapacityController(parseHttpServerConfig(environment)),
    maxRequestBytes: parseHttpServerConfig(environment).maxRequestBytes,
    rateLimitPerMinute: parseHttpServerConfig(environment).registrationRateLimitPerMinute,
    registration,
  });
  const handler: (request: Request) => Promise<Response> = createHttpRequestHandler(
    observations,
    async (_request: Request, _observation: RequestObservation): Promise<Response> =>
      new Response(null, { status: 204 }),
    registrationRoute,
  );
  const body: string = JSON.stringify({
    display_name: "Example",
    registration_secret: REGISTRATION_SECRET,
    slug: "example-org",
  });
  const failed: Response = await postRegistration(handler, body);
  expect(failed.status).toBe(500);
  expect(JSON.stringify(await failed.json())).not.toContain("must-not-leak");
  fail = false;
  const recovered: Response = await postRegistration(handler, body);
  expect(recovered.status).toBe(201);
  await recovered.arrayBuffer();
});
