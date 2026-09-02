import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { TimeSource } from "./http-capacity.js";

export type ConnectorAuthorizationGrant = {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scope: string;
};

export type ConnectorAuthorizationExchange = {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly resource: string;
};

type StoredGrant = ConnectorAuthorizationGrant & { readonly expiresAt: number };

function authorizationCodeKey(code: string): string {
  return createHash("sha256").update(code).digest("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function equalText(left: string, right: string): boolean {
  const leftBytes: Buffer = Buffer.from(left, "utf8");
  const rightBytes: Buffer = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export class ConnectorAuthorizationCodeStore {
  private readonly grants: Map<string, StoredGrant>;
  private readonly lifetimeMs: number;
  private readonly maximumGrants: number;
  private readonly time: TimeSource;

  public constructor(time: TimeSource, lifetimeMs: number, maximumGrants: number) {
    this.grants = new Map<string, StoredGrant>();
    this.lifetimeMs = lifetimeMs;
    this.maximumGrants = maximumGrants;
    this.time = time;
  }

  private pruneExpired(now: number): void {
    this.grants.forEach((grant: StoredGrant, key: string): void => {
      if (grant.expiresAt <= now) this.grants.delete(key);
    });
  }

  public issue(grant: ConnectorAuthorizationGrant): string | null {
    const now: number = this.time.now();
    this.pruneExpired(now);
    if (this.grants.size >= this.maximumGrants) return null;
    const code: string = randomBytes(32).toString("base64url");
    this.grants.set(authorizationCodeKey(code), {
      ...grant,
      expiresAt: now + this.lifetimeMs,
    });
    return code;
  }

  public consume(exchange: ConnectorAuthorizationExchange): StoredGrant | null {
    const now: number = this.time.now();
    this.pruneExpired(now);
    const key: string = authorizationCodeKey(exchange.code);
    const grant: StoredGrant | undefined = this.grants.get(key);
    if (grant === undefined) return null;
    const matches: boolean =
      equalText(grant.clientId, exchange.clientId) &&
      equalText(grant.issuer, exchange.issuer) &&
      equalText(grant.redirectUri, exchange.redirectUri) &&
      equalText(grant.resource, exchange.resource) &&
      equalText(grant.codeChallenge, codeChallenge(exchange.codeVerifier));
    if (!matches || grant.expiresAt <= now) return null;
    // Validation and deletion are synchronous, so concurrent exchanges have exactly one winner.
    this.grants.delete(key);
    return grant;
  }

  public clear(): void {
    this.grants.clear();
  }
}
