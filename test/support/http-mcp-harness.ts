import { expect } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { TenantId } from "../../src/domain/value-objects.js";
import { HostedAuthenticator } from "../../src/hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../../src/hosted/control-plane.js";
import { credentialAdmissionKey } from "../../src/hosted/token-secret.js";

const API_TOKEN: string = "test-murmur-api-token";
export const JsonRpcEnvelopeSchema: z.ZodObject<{
  result: z.ZodType<unknown>;
}> = z.object({ result: z.unknown() });

export function testEnvironment(databasePath: string): NodeJS.ProcessEnv {
  return {
    MURMUR_API_TOKEN: API_TOKEN,
    MURMUR_DB_PATH: databasePath,
    MURMUR_HTTP_HOST: "127.0.0.1",
    MURMUR_LOG_LEVEL: "off",
    PORT: "0",
  };
}

export function requestHeaders(
  sessionId: string | null = null,
  token: string = API_TOKEN,
): Headers {
  const headers: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "feature/http-context",
    "X-Murmur-Client": "claude",
    "X-Murmur-Repository": "mattpatagon/murmur",
  });
  if (sessionId !== null) {
    headers.set("Mcp-Session-Id", sessionId);
    headers.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return headers;
}

export async function postJsonWithToken(
  url: URL,
  body: Record<string, unknown>,
  token: string,
  sessionId: string | null = null,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: requestHeaders(sessionId, token),
    method: "POST",
  });
}

export async function postJson(
  url: URL,
  body: Record<string, unknown>,
  sessionId: string | null,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: requestHeaders(sessionId),
    method: "POST",
  });
}

export async function responsePayload(response: Response): Promise<unknown> {
  const text: string = await response.text();
  const contentType: string = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const dataLines: string[] = text
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "));
  const lastLine: string | undefined = dataLines.at(-1);
  if (lastLine === undefined) throw new Error("MCP SSE response did not include a data event");
  return JSON.parse(lastLine.slice("data: ".length));
}

export function initializeRequest(
  id: number,
  name: string = "remote-test",
  version: string = "1.0.0",
): Record<string, unknown> {
  return {
    id,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name, version },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  };
}

export class AdmissionTestAuthenticator extends HostedAuthenticator {
  private forgedAuthentications: number;
  private readonly forgedWaiters: Array<() => void>;
  private readonly releaseForgedAuthentication: () => void;
  private readonly forgedAuthenticationReleased: Promise<void>;
  private readonly validToken: string;
  private validTokenActive: boolean;

  public constructor(validToken: string) {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
    this.forgedAuthentications = 0;
    this.forgedWaiters = [];
    this.validToken = validToken;
    this.validTokenActive = true;
    let release: (() => void) | undefined;
    this.forgedAuthenticationReleased = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    if (release === undefined) throw new Error("Forged authentication release was not initialized");
    this.releaseForgedAuthentication = release;
  }

  public override credentialAdmission(token: string): CredentialAdmission | null {
    return this.validTokenActive && token === this.validToken
      ? { key: credentialAdmissionKey(token), tenantKey: "founding-tenant-admission-key" }
      : null;
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    if (token === this.validToken) {
      return {
        kind: "tenant",
        role: "agent",
        tenantId: TenantId.founding(),
        tokenId: "first-use-valid-token",
      };
    }
    this.forgedAuthentications += 1;
    this.forgedWaiters.splice(0).forEach((resolve: () => void): void => {
      resolve();
    });
    await this.forgedAuthenticationReleased;
    return null;
  }

  public releaseForged(): void {
    this.releaseForgedAuthentication();
  }

  public deactivateValidToken(): void {
    this.validTokenActive = false;
  }

  public async waitForForged(count: number): Promise<void> {
    while (this.forgedAuthentications < count) {
      await new Promise<void>((resolve: () => void): void => {
        this.forgedWaiters.push(resolve);
      });
    }
  }
}

export class TenantBurstAuthenticator extends HostedAuthenticator {
  private activeAuthentications: number;
  private readonly activeWaiters: Array<() => void>;
  private readonly knownTokens: ReadonlySet<string>;
  private readonly releaseAuthentications: () => void;
  private readonly authenticationsReleased: Promise<void>;

  public constructor(knownTokens: readonly string[]) {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
    this.activeAuthentications = 0;
    this.activeWaiters = [];
    this.knownTokens = new Set<string>(knownTokens);
    let release: (() => void) | undefined;
    this.authenticationsReleased = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    if (release === undefined) throw new Error("Authentication release was not initialized");
    this.releaseAuthentications = release;
  }

  public override credentialAdmission(token: string): CredentialAdmission | null {
    return this.knownTokens.has(token)
      ? { key: credentialAdmissionKey(token), tenantKey: "burst-tenant-admission-key" }
      : null;
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    if (!this.knownTokens.has(token)) return null;
    this.activeAuthentications += 1;
    this.activeWaiters.splice(0).forEach((resolve: () => void): void => {
      resolve();
    });
    await this.authenticationsReleased;
    return {
      kind: "tenant",
      role: "agent",
      tenantId: TenantId.founding(),
      tokenId: credentialAdmissionKey(token),
    };
  }

  public release(): void {
    this.releaseAuthentications();
  }

  public async waitForActive(count: number): Promise<void> {
    while (this.activeAuthentications < count) {
      await new Promise<void>((resolve: () => void): void => {
        this.activeWaiters.push(resolve);
      });
    }
  }
}

export async function initializeSession(
  url: URL,
  name: string = "remote-test",
  version: string = "1.0.0",
): Promise<string> {
  const response: Response = await postJson(url, initializeRequest(1, name, version), null);
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await responsePayload(response));
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("MCP initialize response did not include a session ID");
  const initialized: Response = await postJson(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expect(initialized.status).toBe(202);
  return sessionId;
}
