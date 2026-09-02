import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  ConnectorAuthorizationCodeStore,
  type ConnectorAuthorizationExchange,
  type ConnectorAuthorizationGrant,
} from "../src/http/connector-authorization-code-store.js";
import type { TimeSource } from "../src/http/http-capacity.js";

class ManualTimeSource implements TimeSource {
  private milliseconds: number;

  public constructor() {
    this.milliseconds = 0;
  }

  public advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }

  public now(): number {
    return this.milliseconds;
  }

  public schedule(_milliseconds: number, _wake: () => void): () => void {
    return (): void => {};
  }
}

const VERIFIER: string = "connector-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function grant(): ConnectorAuthorizationGrant {
  return {
    clientId: "murmur",
    codeChallenge: challenge(VERIFIER),
    issuer: "https://api.usemurmur.dev",
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: "https://api.usemurmur.dev/mcp",
    scope: "murmur",
  };
}

function exchange(code: string): ConnectorAuthorizationExchange {
  return {
    clientId: "murmur",
    code,
    codeVerifier: VERIFIER,
    issuer: "https://api.usemurmur.dev",
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: "https://api.usemurmur.dev/mcp",
  };
}

test("connector authorization codes are bounded, expiring, and absent after restart", (): void => {
  const time: ManualTimeSource = new ManualTimeSource();
  const firstStore: ConnectorAuthorizationCodeStore = new ConnectorAuthorizationCodeStore(
    time,
    10,
    1,
  );
  const firstCode: string | null = firstStore.issue(grant());
  if (firstCode === null) throw new Error("The first authorization code was not issued");
  expect(firstStore.issue(grant())).toBeNull();

  const restartedStore: ConnectorAuthorizationCodeStore = new ConnectorAuthorizationCodeStore(
    time,
    10,
    1,
  );
  expect(restartedStore.consume(exchange(firstCode))).toBeNull();

  time.advance(10);
  const replacement: string | null = firstStore.issue(grant());
  expect(replacement).not.toBeNull();
  expect(firstStore.consume(exchange(firstCode))).toBeNull();
});

test("connector authorization codes bind every security parameter and reject replay", (): void => {
  const mismatches: readonly Partial<ConnectorAuthorizationExchange>[] = [
    { clientId: "different-client" },
    { codeVerifier: "different-verifier-abcdefghijklmnopqrstuvwxyz-0123456789" },
    { issuer: "https://alternate.usemurmur.dev" },
    { redirectUri: "https://grok.com/oauth/callback" },
    { resource: "https://api.usemurmur.dev/other" },
  ];
  mismatches.forEach((mismatch: Partial<ConnectorAuthorizationExchange>): void => {
    const store: ConnectorAuthorizationCodeStore = new ConnectorAuthorizationCodeStore(
      new ManualTimeSource(),
      10_000,
      1,
    );
    const code: string | null = store.issue(grant());
    if (code === null) throw new Error("The authorization code was not issued");
    expect(store.consume({ ...exchange(code), ...mismatch })).toBeNull();
    expect(store.consume(exchange(code))).toEqual({ ...grant(), expiresAt: 10_000 });
    expect(store.consume(exchange(code))).toBeNull();
  });

  const successfulStore: ConnectorAuthorizationCodeStore = new ConnectorAuthorizationCodeStore(
    new ManualTimeSource(),
    10_000,
    1,
  );
  const code: string | null = successfulStore.issue(grant());
  if (code === null) throw new Error("The authorization code was not issued");
  expect(successfulStore.consume(exchange(code))).toEqual({ ...grant(), expiresAt: 10_000 });
  expect(successfulStore.consume(exchange(code))).toBeNull();
});
