import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  initializeRequest,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

const CLIENT_ID: string = "murmur";
const CLIENT_SECRET: string = "test-murmur-api-token";
const CHATGPT_REDIRECT_URI: string = "https://chatgpt.com/connector_platform_oauth_redirect";
const GROK_REDIRECT_URI: string = "https://grok.com/oauth/callback";

async function postConnectorJson(
  url: URL,
  body: Record<string, unknown>,
  token: string,
  sessionId: string | null = null,
): Promise<Response> {
  const headers: Headers = requestHeaders(sessionId, token);
  headers.delete("x-murmur-branch");
  headers.delete("x-murmur-client");
  headers.delete("x-murmur-repository");
  return await fetch(url, { body: JSON.stringify(body), headers, method: "POST" });
}

function requireAuthorizationServerMetadata(
  value: AuthorizationServerMetadata | undefined,
): AuthorizationServerMetadata {
  if (value === undefined) throw new Error("Authorization server metadata was not discovered");
  return value;
}

async function authorizationCode(
  server: MurmurHttpServer,
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  state: string,
): Promise<{ readonly code: string; readonly verifier: string }> {
  const started: Awaited<ReturnType<typeof startAuthorization>> = await startAuthorization(
    new URL(server.mcpUrl.origin),
    {
      clientInformation: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
      metadata,
      redirectUrl: redirectUri,
      resource: server.mcpUrl,
      scope: "murmur",
      state,
    },
  );
  expect(started.authorizationUrl.href).not.toContain(CLIENT_SECRET);
  const response: Response = await fetch(started.authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location: string | null = response.headers.get("location");
  if (location === null) throw new Error("Authorization response omitted its redirect location");
  const redirected: URL = new URL(location);
  expect(redirected.origin).toBe(new URL(redirectUri).origin);
  expect(redirected.pathname).toBe(new URL(redirectUri).pathname);
  expect(redirected.searchParams.get("state")).toBe(state);
  expect(redirected.searchParams.get("iss")).toBe(server.mcpUrl.origin);
  const code: string | null = redirected.searchParams.get("code");
  if (code === null) throw new Error("Authorization response omitted its code");
  return { code, verifier: started.codeVerifier };
}

async function connect(
  server: MurmurHttpServer,
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  authMethods: readonly string[],
  state: string,
): Promise<OAuthTokens> {
  const issued: { readonly code: string; readonly verifier: string } = await authorizationCode(
    server,
    metadata,
    redirectUri,
    state,
  );
  return await exchangeAuthorization(new URL(server.mcpUrl.origin), {
    authorizationCode: issued.code,
    clientInformation: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    codeVerifier: issued.verifier,
    metadata: { ...metadata, token_endpoint_auth_methods_supported: [...authMethods] },
    redirectUri,
    resource: server.mcpUrl,
  });
}

async function initializeConnectorSession(
  server: MurmurHttpServer,
  token: string,
  requestId: number,
  name: string,
): Promise<string> {
  const initialized: Response = await postConnectorJson(
    server.mcpUrl,
    initializeRequest(requestId, name),
    token,
  );
  expect(initialized.status).toBe(200);
  expect(await responsePayload(initialized)).toHaveProperty("result");
  const sessionId: string | null = initialized.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Connector initialization omitted its session ID");
  const acknowledged: Response = await postConnectorJson(
    server.mcpUrl,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    token,
    sessionId,
  );
  expect(acknowledged.status).toBe(202);
  return sessionId;
}

async function connectorToolCall(
  server: MurmurHttpServer,
  token: string,
  sessionId: string,
  requestId: number,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const response: Response = await postConnectorJson(
    server.mcpUrl,
    {
      id: requestId,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: argumentsValue, name },
    },
    token,
    sessionId,
  );
  expect(response.status).toBe(200);
  return await responsePayload(response);
}

test("ChatGPT and Grok connector OAuth exchanges produce usable Murmur bearer tokens", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-connector-oauth-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const challenge: Response = await fetch(server.mcpUrl, { method: "POST" });
    expect(challenge.status).toBe(401);
    const challengeParameters: ReturnType<typeof extractWWWAuthenticateParams> =
      extractWWWAuthenticateParams(challenge);
    expect(challengeParameters.scope).toBe("murmur");
    const resourceMetadataUrl: URL | undefined = challengeParameters.resourceMetadataUrl;
    expect(resourceMetadataUrl === undefined ? undefined : resourceMetadataUrl.href).toBe(
      `${server.mcpUrl.origin}/.well-known/oauth-protected-resource/mcp`,
    );

    const resourceMetadata: OAuthProtectedResourceMetadata =
      await discoverOAuthProtectedResourceMetadata(server.mcpUrl);
    expect(resourceMetadata).toEqual({
      authorization_servers: [server.mcpUrl.origin],
      resource: server.mcpUrl.href,
      resource_documentation: `${server.mcpUrl.origin}/`,
      resource_name: "Murmur",
      scopes_supported: ["murmur"],
    });
    const authorizationServers: string[] | undefined = resourceMetadata.authorization_servers;
    const authorizationServer: string | undefined =
      authorizationServers === undefined ? undefined : authorizationServers[0];
    if (authorizationServer === undefined) {
      throw new Error("Protected resource metadata omitted its authorization server");
    }
    const metadata: AuthorizationServerMetadata = requireAuthorizationServerMetadata(
      await discoverAuthorizationServerMetadata(authorizationServer),
    );
    expect(metadata.authorization_endpoint).toBe(`${server.mcpUrl.origin}/oauth/authorize`);
    expect(metadata.token_endpoint).toBe(`${server.mcpUrl.origin}/oauth/token`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
      "client_secret_post",
    ]);

    const chatGpt: OAuthTokens = await connect(
      server,
      metadata,
      CHATGPT_REDIRECT_URI,
      ["client_secret_basic"],
      "chatgpt-state",
    );
    const grok: OAuthTokens = await connect(
      server,
      metadata,
      GROK_REDIRECT_URI,
      ["client_secret_post"],
      "grok-state",
    );
    expect(chatGpt).toEqual({ access_token: CLIENT_SECRET, scope: "murmur", token_type: "Bearer" });
    expect(grok).toEqual({ access_token: CLIENT_SECRET, scope: "murmur", token_type: "Bearer" });

    const chatGptSession: string = await initializeConnectorSession(
      server,
      chatGpt.access_token,
      1,
      "chatgpt-connector",
    );
    const grokSession: string = await initializeConnectorSession(
      server,
      grok.access_token,
      2,
      "grok-connector",
    );
    await connectorToolCall(server, chatGpt.access_token, chatGptSession, 3, "register_agent", {
      agent_id: "connector-chatgpt",
      display_name: "ChatGPT connector",
    });
    await connectorToolCall(server, grok.access_token, grokSession, 4, "register_agent", {
      agent_id: "connector-grok",
      display_name: "Grok connector",
    });
    const sent: unknown = await connectorToolCall(
      server,
      chatGpt.access_token,
      chatGptSession,
      5,
      "send_message",
      {
        content: "hello across connector machines",
        context: {
          branch: "connector/e2e",
          client: "connector",
          repository: "mattpatagon/murmur",
        },
        recipient_id: "connector-grok",
        sender_id: "connector-chatgpt",
      },
    );
    expect(JSON.stringify(sent)).toContain("hello across connector machines");
    const received: unknown = await connectorToolCall(
      server,
      grok.access_token,
      grokSession,
      6,
      "get_messages",
      {
        after_sequence: 0,
        agent_id: "connector-grok",
        limit: 10,
        unread_only: false,
      },
    );
    expect(JSON.stringify(received)).toContain("hello across connector machines");
    expect(JSON.stringify(received)).toContain('"client":"connector"');
    const returned: unknown = await connectorToolCall(
      server,
      grok.access_token,
      grokSession,
      7,
      "send_message",
      {
        content: "reply from Grok",
        context: {
          branch: "connector/e2e",
          client: "connector",
          repository: "mattpatagon/murmur",
        },
        recipient_id: "connector-chatgpt",
        sender_id: "connector-grok",
      },
    );
    expect(JSON.stringify(returned)).toContain('"client":"connector"');
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("connector OAuth rejects unsafe redirects, missing secrets, PKCE mismatch, and replay", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-connector-oauth-security-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const metadata: AuthorizationServerMetadata = requireAuthorizationServerMetadata(
      await discoverAuthorizationServerMetadata(server.mcpUrl.origin),
    );
    const unsafe: Awaited<ReturnType<typeof startAuthorization>> = await startAuthorization(
      server.mcpUrl.origin,
      {
        clientInformation: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
        metadata,
        redirectUrl: "https://attacker.example/callback",
        resource: server.mcpUrl,
        scope: "murmur",
        state: "unsafe-state",
      },
    );
    const unsafeResponse: Response = await fetch(unsafe.authorizationUrl, { redirect: "manual" });
    expect(unsafeResponse.status).toBe(400);
    expect(unsafeResponse.headers.get("location")).toBeNull();

    const nonPkce: Awaited<ReturnType<typeof startAuthorization>> = await startAuthorization(
      server.mcpUrl.origin,
      {
        clientInformation: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
        metadata,
        redirectUrl: CHATGPT_REDIRECT_URI,
        resource: server.mcpUrl,
        scope: "murmur",
      },
    );
    nonPkce.authorizationUrl.searchParams.set("code_challenge_method", "plain");
    nonPkce.authorizationUrl.searchParams.set("state", "safe-state");
    const nonPkceResponse: Response = await fetch(nonPkce.authorizationUrl, {
      redirect: "manual",
    });
    expect(nonPkceResponse.status).toBe(302);
    const nonPkceLocation: string | null = nonPkceResponse.headers.get("location");
    if (nonPkceLocation === null) throw new Error("OAuth error response omitted its redirect");
    const nonPkceRedirect: URL = new URL(nonPkceLocation);
    expect(nonPkceRedirect.searchParams.get("error")).toBe("invalid_request");
    expect(nonPkceRedirect.searchParams.get("state")).toBe("safe-state");
    expect(nonPkceRedirect.searchParams.get("iss")).toBe(server.mcpUrl.origin);

    const issued: { readonly code: string; readonly verifier: string } = await authorizationCode(
      server,
      metadata,
      CHATGPT_REDIRECT_URI,
      "security-state",
    );
    const missingSecret: Response = await fetch(`${server.mcpUrl.origin}/oauth/token`, {
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        code: issued.code,
        code_verifier: issued.verifier,
        grant_type: "authorization_code",
        redirect_uri: CHATGPT_REDIRECT_URI,
        resource: server.mcpUrl.href,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(missingSecret.status).toBe(401);
    expect(await missingSecret.json()).toEqual({
      error: "invalid_client",
      error_description: "Client authentication failed",
    });

    const unsupportedGrant: URLSearchParams = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    });
    const unsupportedGrantResponse: Response = await fetch(`${server.mcpUrl.origin}/oauth/token`, {
      body: unsupportedGrant,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(unsupportedGrantResponse.status).toBe(400);
    expect(await unsupportedGrantResponse.json()).toEqual({
      error: "unsupported_grant_type",
      error_description: "Token grant type is unsupported",
    });

    const wrongVerifier: Response = await fetch(`${server.mcpUrl.origin}/oauth/token`, {
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: issued.code,
        code_verifier: "wrong-verifier-that-is-long-enough-to-be-well-formed-1234567890",
        grant_type: "authorization_code",
        redirect_uri: CHATGPT_REDIRECT_URI,
        resource: server.mcpUrl.href,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toEqual({
      error: "invalid_grant",
      error_description: "Authorization grant is invalid or expired",
    });

    const validBody: URLSearchParams = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: issued.code,
      code_verifier: issued.verifier,
      grant_type: "authorization_code",
      redirect_uri: CHATGPT_REDIRECT_URI,
      resource: server.mcpUrl.href,
    });
    const recovered: Response = await fetch(`${server.mcpUrl.origin}/oauth/token`, {
      body: validBody,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("cache-control")).toBe("no-store");
    const replay: Response = await fetch(`${server.mcpUrl.origin}/oauth/token`, {
      body: validBody,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(replay.status).toBe(400);
    expect(await replay.text()).not.toContain(CLIENT_SECRET);
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
