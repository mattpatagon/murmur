import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { connectorProtectedResourceMetadataUrl } from "../src/http/connector-oauth.js";
import { testEnvironment } from "./support/http-mcp-harness.js";

const CLIENT_SECRET: string = "test-murmur-api-token";
const PUBLIC_ORIGIN: string = "https://api.example.com";
const REDIRECT_URI: string = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER: string = "canonical-origin-verifier-with-forty-three-characters";

function spoofedHeaders(additional: HeadersInit = {}): Headers {
  const headers: Headers = new Headers(additional);
  headers.set("host", "spoofed.example");
  headers.set("x-forwarded-host", "forwarded-spoof.example");
  headers.set("x-forwarded-proto", "http");
  return headers;
}

test("configured public origin defeats Host spoofing across discovery and exchange", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-oauth-origin-"));
  const server: MurmurHttpServer = await startHttpServer({
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  });
  try {
    const metadataResponse: Response = await fetch(
      new URL("/.well-known/oauth-authorization-server", server.mcpUrl.origin),
      { headers: spoofedHeaders() },
    );
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      authorization_endpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
      issuer: PUBLIC_ORIGIN,
      token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
    });

    const challenge: Response = await fetch(server.mcpUrl, {
      headers: spoofedHeaders(),
      method: "POST",
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      `resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const authorization: URL = new URL("/oauth/authorize", server.mcpUrl.origin);
    authorization.search = new URLSearchParams({
      client_id: "murmur",
      code_challenge: createHash("sha256").update(VERIFIER, "ascii").digest("base64url"),
      code_challenge_method: "S256",
      redirect_uri: REDIRECT_URI,
      resource: `${PUBLIC_ORIGIN}/mcp`,
      response_type: "code",
      scope: "murmur",
      state: "canonical-state",
    }).toString();
    const authorized: Response = await fetch(authorization, {
      headers: spoofedHeaders(),
      redirect: "manual",
    });
    expect(authorized.status).toBe(302);
    const location: string | null = authorized.headers.get("location");
    if (location === null) throw new Error("Authorization redirect was omitted");
    const redirect: URL = new URL(location);
    expect(redirect.searchParams.get("iss")).toBe(PUBLIC_ORIGIN);
    expect(redirect.searchParams.get("state")).toBe("canonical-state");
    const code: string | null = redirect.searchParams.get("code");
    if (code === null) throw new Error("Authorization code was omitted");

    const token: Response = await fetch(new URL("/oauth/token", server.mcpUrl.origin), {
      body: new URLSearchParams({
        client_id: "murmur",
        client_secret: CLIENT_SECRET,
        code,
        code_verifier: VERIFIER,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        resource: `${PUBLIC_ORIGIN}/mcp`,
      }),
      headers: spoofedHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      method: "POST",
    });
    expect(token.status).toBe(200);
    expect(await token.json()).toEqual({
      access_token: CLIENT_SECRET,
      scope: "murmur",
      token_type: "Bearer",
    });
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("missing public origin fails closed for non-loopback requests", (): void => {
  const unconfigured: Request = new Request("https://unconfigured.example/mcp");
  const configured: Request = new Request("https://spoofed.example/mcp");
  expect(connectorProtectedResourceMetadataUrl(unconfigured, null)).toBeNull();
  expect(connectorProtectedResourceMetadataUrl(configured, PUBLIC_ORIGIN)).toBe(
    `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
  );
});
