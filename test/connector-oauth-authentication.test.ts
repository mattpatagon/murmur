import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverAuthorizationServerMetadata,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import { RepositoryName, TenantId } from "../src/domain/value-objects.js";
import { HostedAuthenticator } from "../src/hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../src/hosted/control-plane.js";
import { credentialAdmissionKey } from "../src/hosted/token-secret.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { initializeRequest, requestHeaders, testEnvironment } from "./support/http-mcp-harness.js";

const CLIENT_ID: string = "murmur";
const REDIRECT_URI: string = "https://chatgpt.com/connector_platform_oauth_redirect";

type AuthorizationGrant = { readonly code: string; readonly verifier: string };

class MutableAuthenticator extends HostedAuthenticator {
  private failAuthentication: boolean;
  private principal: HostedPrincipal;
  private token: string;

  public constructor(token: string, principal: HostedPrincipal) {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
    this.failAuthentication = false;
    this.principal = principal;
    this.token = token;
  }

  public override credentialAdmission(token: string): CredentialAdmission | null {
    return token === this.token
      ? { key: credentialAdmissionKey(token), tenantKey: "connector-tenant" }
      : null;
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    if (this.failAuthentication) throw new Error(`Authentication failed for ${token}`);
    return token === this.token ? this.principal : null;
  }

  public fail(): void {
    this.failAuthentication = true;
  }

  public replace(token: string, principal: HostedPrincipal): void {
    this.failAuthentication = false;
    this.principal = principal;
    this.token = token;
  }
}

function tenantPrincipal(): HostedPrincipal {
  return {
    agentId: null,
    kind: "tenant",
    personalId: null,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    role: "agent",
    tenantId: TenantId.founding(),
    tokenId: "connector-token",
  };
}

function credential(label: string): string {
  return ["test", "murmur", label, "credential"].join("-");
}

async function metadata(server: MurmurHttpServer): Promise<AuthorizationServerMetadata> {
  const value: AuthorizationServerMetadata | undefined = await discoverAuthorizationServerMetadata(
    server.mcpUrl.origin,
  );
  if (value === undefined) throw new Error("Authorization metadata was not discovered");
  return value;
}

async function issue(server: MurmurHttpServer, token: string): Promise<AuthorizationGrant> {
  const started: Awaited<ReturnType<typeof startAuthorization>> = await startAuthorization(
    server.mcpUrl.origin,
    {
      clientInformation: { client_id: CLIENT_ID, client_secret: token },
      metadata: await metadata(server),
      redirectUrl: REDIRECT_URI,
      resource: server.mcpUrl,
      scope: "murmur",
    },
  );
  const response: Response = await fetch(started.authorizationUrl, { redirect: "manual" });
  const locationValue: string | null = response.headers.get("location");
  if (locationValue === null) throw new Error("Authorization code redirect was omitted");
  const code: string | null = new URL(locationValue).searchParams.get("code");
  if (code === null) throw new Error("Authorization code was omitted");
  return { code, verifier: started.codeVerifier };
}

async function exchange(
  server: MurmurHttpServer,
  token: string,
  grant: AuthorizationGrant,
): Promise<Response> {
  return await fetch(`${server.mcpUrl.origin}/oauth/token`, {
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: token,
      code: grant.code,
      code_verifier: grant.verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: server.mcpUrl.href,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

test("connector exchange preserves token scope and follows rotation and revocation", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-rotation-"));
  const firstToken: string = credential("first");
  const nextToken: string = credential("next");
  const authenticator: MutableAuthenticator = new MutableAuthenticator(
    firstToken,
    tenantPrincipal(),
  );
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
    { authenticator },
  );
  try {
    const first: Response = await exchange(server, firstToken, await issue(server, firstToken));
    expect(await first.json()).toEqual({
      access_token: firstToken,
      scope: "murmur",
      token_type: "Bearer",
    });
    const pending: AuthorizationGrant = await issue(server, firstToken);
    authenticator.replace(nextToken, tenantPrincipal());
    expect((await exchange(server, firstToken, pending)).status).toBe(401);
    const revoked: Response = await fetch(server.mcpUrl, {
      headers: { authorization: `Bearer ${firstToken}` },
      method: "POST",
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(firstToken);

    const rotated: Response = await exchange(server, nextToken, await issue(server, nextToken));
    expect(await rotated.json()).toEqual({
      access_token: nextToken,
      scope: "murmur",
      token_type: "Bearer",
    });
    const headers: Headers = requestHeaders(null, nextToken);
    headers.delete("x-murmur-branch");
    headers.delete("x-murmur-client");
    headers.delete("x-murmur-repository");
    const initialized: Response = await fetch(server.mcpUrl, {
      body: JSON.stringify(initializeRequest(1, "rotated-connector")),
      headers,
      method: "POST",
    });
    expect(initialized.status).toBe(200);
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("connector exchange excludes operator and bootstrap credentials", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-principals-"));
  const token: string = credential("privileged");
  const authenticator: MutableAuthenticator = new MutableAuthenticator(token, {
    credentialHash: Buffer.alloc(32),
    keyId: "operator-key",
    kind: "operator",
    tokenId: "operator-token",
  });
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
    { authenticator },
  );
  try {
    expect((await exchange(server, token, await issue(server, token))).status).toBe(401);
    authenticator.replace(token, {
      keyId: "bootstrap-key",
      kind: "bootstrap",
      tokenId: "bootstrap-token",
    });
    const rejected: Response = await exchange(server, token, await issue(server, token));
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain(token);
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("connector token failures are unavailable, redacted, and one-use under a race", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-race-"));
  const token: string = credential("race");
  const authenticator: MutableAuthenticator = new MutableAuthenticator(token, tenantPrincipal());
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
    { authenticator },
  );
  const originalConsoleError: typeof console.error = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]): void => {
    logs.push(values.map(String).join(" "));
  };
  try {
    const unavailableGrant: AuthorizationGrant = await issue(server, token);
    authenticator.fail();
    const unavailable: Response = await exchange(server, token, unavailableGrant);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);

    authenticator.replace(token, tenantPrincipal());
    const racedGrant: AuthorizationGrant = await issue(server, token);
    const responses: Response[] = await Promise.all([
      exchange(server, token, racedGrant),
      exchange(server, token, racedGrant),
    ]);
    expect(responses.map((response: Response): number => response.status).sort()).toEqual([
      200, 400,
    ]);
  } finally {
    console.error = originalConsoleError;
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
