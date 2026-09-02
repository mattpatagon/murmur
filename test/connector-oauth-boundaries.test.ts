import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { RepositoryName, TenantId } from "../src/domain/value-objects.js";
import { HostedAuthenticator } from "../src/hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../src/hosted/control-plane.js";
import { credentialAdmissionKey } from "../src/hosted/token-secret.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { connectorAuthorizationIssueRateLimit } from "../src/http/connector-oauth-protocol.js";
import {
  initializeRequest,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

const CLIENT_ID: string = "murmur";
const CLIENT_SECRET: string = "test-murmur-api-token";
const SECOND_CLIENT_SECRET: string = "test-murmur-secondary-token";
const REDIRECT_URI: string = "https://chatgpt.com/connector_platform_oauth_redirect";
const CODE_VERIFIER: string = "connector-boundary-verifier-with-forty-three-characters";

type AuthorizationGrant = {
  readonly code: string;
  readonly verifier: string;
};

type Deferred = {
  readonly open: () => void;
  readonly promise: Promise<void>;
};

function deferred(): Deferred {
  let resolver: (() => void) | null = null;
  const promise: Promise<void> = new Promise((resolve: () => void): void => {
    resolver = resolve;
  });
  return {
    open: (): void => {
      const current: (() => void) | null = resolver;
      if (current === null) return;
      resolver = null;
      current();
    },
    promise,
  };
}

function tenantPrincipal(tokenId: string = "connector-boundary-token"): HostedPrincipal {
  return {
    agentId: null,
    kind: "tenant",
    personalId: null,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    role: "agent",
    tenantId: TenantId.founding(),
    tokenId,
  };
}

class RateAuthenticator extends HostedAuthenticator {
  public constructor() {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
  }

  public override credentialAdmission(token: string): CredentialAdmission | null {
    return token === CLIENT_SECRET || token === SECOND_CLIENT_SECRET
      ? { key: credentialAdmissionKey(token), tenantKey: "connector-rate-tenant" }
      : null;
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    return token === CLIENT_SECRET || token === SECOND_CLIENT_SECRET
      ? tenantPrincipal(token)
      : null;
  }
}

class BlockingAuthenticator extends HostedAuthenticator {
  private readonly entered: Deferred;
  private readonly released: Deferred;

  public constructor() {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
    this.entered = deferred();
    this.released = deferred();
  }

  public override credentialAdmission(token: string): CredentialAdmission | null {
    return token === CLIENT_SECRET
      ? { key: credentialAdmissionKey(token), tenantKey: "connector-boundary-tenant" }
      : null;
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    if (token !== CLIENT_SECRET) return null;
    this.entered.open();
    await this.released.promise;
    return tenantPrincipal();
  }

  public async waitUntilEntered(): Promise<void> {
    await this.entered.promise;
  }

  public release(): void {
    this.released.open();
  }
}

function authorizationUrl(server: MurmurHttpServer, state: string = "boundary-state"): URL {
  const challenge: string = createHash("sha256").update(CODE_VERIFIER, "ascii").digest("base64url");
  const url: URL = new URL("/oauth/authorize", server.mcpUrl.origin);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: server.mcpUrl.href,
    response_type: "code",
    scope: "murmur",
    state,
  }).toString();
  return url;
}

async function issueAuthorizationCode(server: MurmurHttpServer): Promise<AuthorizationGrant> {
  const response: Response = await fetch(authorizationUrl(server), { redirect: "manual" });
  const location: string | null = response.headers.get("location");
  if (location === null) throw new Error("Authorization response omitted its redirect");
  const code: string | null = new URL(location).searchParams.get("code");
  if (code === null) throw new Error("Authorization response omitted its code");
  return { code, verifier: CODE_VERIFIER };
}

function tokenForm(
  grant: AuthorizationGrant,
  clientSecret: string = CLIENT_SECRET,
): URLSearchParams {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: clientSecret,
    code: grant.code,
    code_verifier: grant.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    resource: "http://unused.invalid/mcp",
  });
}

async function exchange(server: MurmurHttpServer, grant: AuthorizationGrant): Promise<Response> {
  const form: URLSearchParams = tokenForm(grant);
  form.set("resource", server.mcpUrl.href);
  return await fetch(new URL("/oauth/token", server.mcpUrl.origin), {
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

async function exchangeWithSecret(
  server: MurmurHttpServer,
  grant: AuthorizationGrant,
  clientSecret: string,
): Promise<Response> {
  const form: URLSearchParams = tokenForm(grant, clientSecret);
  form.set("resource", server.mcpUrl.href);
  return await fetch(new URL("/oauth/token", server.mcpUrl.origin), {
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

test("connector authorization rate math covers configuration extrema", (): void => {
  expect(connectorAuthorizationIssueRateLimit(1, 1, 1)).toBe(0);
  expect(connectorAuthorizationIssueRateLimit(1, 4_096, 10_000)).toBe(2_047);
  expect(connectorAuthorizationIssueRateLimit(600_000, 12, 100)).toBe(1);
  expect(connectorAuthorizationIssueRateLimit(300_000, 256, 30)).toBe(30);
});

test("connector OAuth rejects malformed, duplicate, oversized, and wrong-method requests", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-boundaries-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const wrongMethods: readonly {
      readonly allow: string;
      readonly method: string;
      readonly path: string;
    }[] = [
      { allow: "GET", method: "POST", path: "/oauth/authorize" },
      { allow: "POST", method: "GET", path: "/oauth/token" },
      { allow: "GET", method: "POST", path: "/.well-known/oauth-authorization-server" },
    ];
    for (const request of wrongMethods) {
      const response: Response = await fetch(new URL(request.path, server.mcpUrl.origin), {
        method: request.method,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(request.allow);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    const duplicate: URL = authorizationUrl(server);
    duplicate.searchParams.append("client_id", "duplicate");
    const oversized: URL = authorizationUrl(server, "x".repeat(8_192));
    for (const url of [duplicate, oversized]) {
      const response: Response = await fetch(url, { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description: "Authorization request is invalid",
      });
    }

    const emptyState: Response = await fetch(authorizationUrl(server, ""), {
      redirect: "manual",
    });
    expect(emptyState.status).toBe(302);
    const emptyStateLocation: string | null = emptyState.headers.get("location");
    if (emptyStateLocation === null) throw new Error("OAuth error redirect was omitted");
    const emptyStateRedirect: URL = new URL(emptyStateLocation);
    expect(emptyStateRedirect.origin).toBe(new URL(REDIRECT_URI).origin);
    expect(emptyStateRedirect.searchParams.get("error")).toBe("invalid_request");
    expect(emptyStateRedirect.searchParams.has("state")).toBe(false);

    const authorizationErrors: readonly {
      readonly expected: string;
      readonly name: string;
      readonly value: string;
    }[] = [
      { expected: "unsupported_response_type", name: "response_type", value: "token" },
      { expected: "invalid_scope", name: "scope", value: "other" },
      { expected: "invalid_target", name: "resource", value: "https://other.example/mcp" },
    ];
    for (const authorizationError of authorizationErrors) {
      const url: URL = authorizationUrl(server, `state-${authorizationError.expected}`);
      url.searchParams.set(authorizationError.name, authorizationError.value);
      const response: Response = await fetch(url, { redirect: "manual" });
      expect(response.status).toBe(302);
      const location: string | null = response.headers.get("location");
      if (location === null) throw new Error("OAuth error redirect was omitted");
      const redirect: URL = new URL(location);
      expect(redirect.searchParams.get("error")).toBe(authorizationError.expected);
      expect(redirect.searchParams.get("state")).toBe(`state-${authorizationError.expected}`);
      expect(redirect.searchParams.get("iss")).toBe(server.mcpUrl.origin);
    }

    const tokenUrl: URL = new URL("/oauth/token", server.mcpUrl.origin);
    const malformedBasic: Response = await fetch(tokenUrl, {
      body: "grant_type=authorization_code",
      headers: {
        authorization: "Basic !!!",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(malformedBasic.status).toBe(401);

    const mixed: Response = await fetch(tokenUrl, {
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
      headers: {
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(mixed.status).toBe(401);

    const invalidContentType: Response = await fetch(tokenUrl, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(invalidContentType.status).toBe(400);
    const oversizedBody: Response = await fetch(tokenUrl, {
      body: `state=${"x".repeat(8_192)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(oversizedBody.status).toBe(400);
    for (const response of [malformedBasic, mixed, invalidContentType, oversizedBody]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(CLIENT_SECRET);
    }
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("connector authorization issuance stays below the live code pool bound", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-issue-rate-"));
  const server: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_OAUTH_AUTHORIZATION_CODE_LIFETIME_MS: "600000",
    MURMUR_OAUTH_AUTHORIZATION_RATE_LIMIT_PER_MINUTE: "100",
    MURMUR_OAUTH_MAX_AUTHORIZATION_CODES: "12",
  });
  try {
    const first: Response = await fetch(authorizationUrl(server, "first"), {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const firstLocation: string | null = first.headers.get("location");
    if (firstLocation === null) throw new Error("Authorization code redirect was omitted");
    expect(new URL(firstLocation).searchParams.has("code")).toBe(true);

    const bounded: Response = await fetch(authorizationUrl(server, "bounded"), {
      redirect: "manual",
    });
    expect(bounded.status).toBe(302);
    const boundedLocation: string | null = bounded.headers.get("location");
    if (boundedLocation === null) throw new Error("Authorization error redirect was omitted");
    const boundedRedirect: URL = new URL(boundedLocation);
    expect(boundedRedirect.searchParams.get("error")).toBe("temporarily_unavailable");
    expect(boundedRedirect.searchParams.has("code")).toBe(false);
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("public OAuth admission preserves capacity for authenticated MCP", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-request-capacity-"));
  const server: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_MAX_ACTIVE_REQUESTS: "1",
  });
  try {
    const discovery: Response = await fetch(
      new URL("/.well-known/oauth-authorization-server", server.mcpUrl.origin),
    );
    expect(discovery.status).toBe(503);
    expect(discovery.headers.get("retry-after")).toBe("1");

    const initialized: Response = await fetch(server.mcpUrl, {
      body: JSON.stringify(initializeRequest(1, "reserved-mcp")),
      headers: requestHeaders(),
      method: "POST",
    });
    expect(initialized.status).toBe(200);
    expect(await responsePayload(initialized)).toHaveProperty("result");
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("connector token exchanges enforce principal and tenant rate limits", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-token-rate-"));
  const authenticator: RateAuthenticator = new RateAuthenticator();
  const principalServer: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "principal.db")),
      MURMUR_RATE_LIMIT_PER_MINUTE: "1",
      MURMUR_TENANT_RATE_LIMIT_PER_MINUTE: "10",
    },
    { authenticator },
  );
  try {
    expect(
      (await exchange(principalServer, await issueAuthorizationCode(principalServer))).status,
    ).toBe(200);
    const principalLimited: Response = await exchange(
      principalServer,
      await issueAuthorizationCode(principalServer),
    );
    expect(principalLimited.status).toBe(429);
    expect(principalLimited.headers.get("retry-after")).toBe("60");
  } finally {
    await principalServer.stop();
  }

  const tenantServer: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "tenant.db")),
      MURMUR_RATE_LIMIT_PER_MINUTE: "10",
      MURMUR_TENANT_RATE_LIMIT_PER_MINUTE: "1",
    },
    { authenticator },
  );
  try {
    expect((await exchange(tenantServer, await issueAuthorizationCode(tenantServer))).status).toBe(
      200,
    );
    const tenantLimited: Response = await exchangeWithSecret(
      tenantServer,
      await issueAuthorizationCode(tenantServer),
      SECOND_CLIENT_SECRET,
    );
    expect(tenantLimited.status).toBe(429);
    expect(tenantLimited.headers.get("retry-after")).toBe("60");
  } finally {
    await tenantServer.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("connector token authentication saturation is bounded and retryable", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-capacity-"));
  const authenticator: BlockingAuthenticator = new BlockingAuthenticator();
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_AUTHENTICATION_WAIT_MS: "1",
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS_PER_TENANT: "1",
    },
    { authenticator },
  );
  let first: Promise<Response> | null = null;
  try {
    const firstGrant: AuthorizationGrant = await issueAuthorizationCode(server);
    const secondGrant: AuthorizationGrant = await issueAuthorizationCode(server);
    first = exchange(server, firstGrant);
    await authenticator.waitUntilEntered();
    const saturated: Response = await exchange(server, secondGrant);
    expect(saturated.status).toBe(503);
    expect(saturated.headers.get("retry-after")).toBe("1");
    expect(saturated.headers.get("cache-control")).toBe("no-store");
    expect(await saturated.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "Authentication service is busy",
    });
    authenticator.release();
    expect((await first).status).toBe(200);
  } finally {
    if (first !== null) authenticator.release();
    await first;
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
