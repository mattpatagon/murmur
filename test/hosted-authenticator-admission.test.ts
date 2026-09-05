import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";

import { TenantId } from "../src/domain/value-objects.js";
import type { HostedPrincipal } from "../src/hosted/control-plane-contracts.js";
import type { AuthRowV2 } from "../src/hosted/control-plane-rows.js";
import { HostedAuthenticator } from "../src/hosted/hosted-authenticator.js";
import {
  credentialAdmissionKey,
  generateTokenSecret,
  type HostedTokenSecret,
} from "../src/hosted/token-secret.js";

class AuthenticationDatabase {
  public calls: number = 0;
  public result: unknown = [];
  public failure: Error | null = null;
  public readonly database: Sql;
  public readonly hashes: Buffer[] = [];
  private readonly backing: Sql;

  public constructor() {
    this.backing = postgres({ host: "127.0.0.1", max: 1, port: 1 });
    this.database = new Proxy(this.backing, {
      apply: (
        _target: Sql,
        _receiver: unknown,
        argumentsList: readonly unknown[],
      ): Promise<unknown> => {
        this.calls += 1;
        const credentialHash: unknown = argumentsList[1];
        if (Buffer.isBuffer(credentialHash)) this.hashes.push(credentialHash);
        return this.failure === null ? Promise.resolve(this.result) : Promise.reject(this.failure);
      },
    });
  }

  public async close(): Promise<void> {
    await this.backing.end({ timeout: 1 });
  }
}

function tenantRow(token: HostedTokenSecret, tenantId: TenantId): AuthRowV2 {
  return {
    key_id: token.keyId,
    orchestrator_agent_id: null,
    personal_id: randomUUID(),
    principal_kind: "tenant",
    repository_name: null,
    tenant_id: tenantId.value,
    token_id: randomUUID(),
    token_role: "agent",
  };
}

test("hosted admission startup and credential mutations never scan all credentials", async (): Promise<void> => {
  const database: AuthenticationDatabase = new AuthenticationDatabase();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(database.database);
  try {
    await authenticator.start();
    await Promise.all(Array.from({ length: 25 }, (): Promise<void> => authenticator.refresh()));
    expect(database.calls).toBe(0);
  } finally {
    await authenticator.close();
    await database.close();
  }
});

test("successful database authentication warms only the full credential and authoritative tenant", async (): Promise<void> => {
  const database: AuthenticationDatabase = new AuthenticationDatabase();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(database.database);
  const token: HostedTokenSecret = generateTokenSecret("mur");
  const tenantId: TenantId = TenantId.parse(randomUUID());
  database.result = [tenantRow(token, tenantId)];
  try {
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    await authenticator.authenticate(token.secret);
    expect(database.hashes[0]).toEqual(token.hash);
    expect(authenticator.credentialAdmission(token.secret)).toEqual({
      key: credentialAdmissionKey(token.secret),
      tenantKey: credentialAdmissionKey(tenantId.value),
    });
    const wrongSecret: string = `mur_${token.keyId}_${"x".repeat(43)}`;
    expect(authenticator.credentialAdmission(wrongSecret)).toBeNull();
    expect(authenticator.credentialAdmission("malformed")).toBeNull();
    await authenticator.refresh();
    expect(authenticator.credentialAdmission(token.secret)).not.toBeNull();
    await authenticator.authenticate(token.secret);
    expect(database.calls).toBe(2);
    database.result = [];
    expect(await authenticator.authenticate(token.secret)).toBeNull();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    expect(database.calls).toBe(3);
  } finally {
    await authenticator.close();
    await database.close();
  }
});

test("malformed or unavailable authentication removes cached admission", async (): Promise<void> => {
  const database: AuthenticationDatabase = new AuthenticationDatabase();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(database.database);
  const token: HostedTokenSecret = generateTokenSecret("mur");
  const row: AuthRowV2 = tenantRow(token, TenantId.parse(randomUUID()));
  try {
    database.result = [row];
    await authenticator.authenticate(token.secret);
    database.result = [{ ...row, tenant_id: null }];
    await expect(authenticator.authenticate(token.secret)).rejects.toThrow();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    database.result = [row];
    await authenticator.authenticate(token.secret);
    database.failure = new Error("Database unavailable");
    await expect(authenticator.authenticate(token.secret)).rejects.toThrow("Database unavailable");
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    database.failure = null;
    database.result = [{ unexpected: true }];
    await expect(authenticator.authenticate(token.secret)).rejects.toThrow();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    database.result = [row, row];
    await expect(authenticator.authenticate(token.secret)).rejects.toThrow();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
  } finally {
    await authenticator.close();
    await database.close();
  }
});

test("closing authentication clears admissions and is idempotent", async (): Promise<void> => {
  const database: AuthenticationDatabase = new AuthenticationDatabase();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(database.database);
  const token: HostedTokenSecret = generateTokenSecret("mur");
  database.result = [tenantRow(token, TenantId.parse(randomUUID()))];
  try {
    await authenticator.authenticate(token.secret);
    await authenticator.close();
    await authenticator.close();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    await expect(authenticator.authenticate(token.secret)).rejects.toThrow("closed");
    expect((): Promise<void> => authenticator.start()).toThrow("closed");
    expect((): Promise<void> => authenticator.refresh()).toThrow("closed");
  } finally {
    await authenticator.close();
    await database.close();
  }
});

test("operator and bootstrap hints never acquire tenant admission capacity", async (): Promise<void> => {
  const database: AuthenticationDatabase = new AuthenticationDatabase();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(database.database);
  try {
    for (const kind of ["operator", "bootstrap"]) {
      const token: HostedTokenSecret = generateTokenSecret("mur_op");
      database.result = [
        {
          ...tenantRow(token, TenantId.parse(randomUUID())),
          personal_id: null,
          principal_kind: kind,
          tenant_id: null,
          token_role: null,
        },
      ];
      await authenticator.authenticate(token.secret);
      expect(authenticator.credentialAdmission(token.secret)).toEqual({
        key: credentialAdmissionKey(token.secret),
        tenantKey: null,
      });
      database.result = [
        {
          ...tenantRow(token, TenantId.parse(randomUUID())),
          principal_kind: kind,
        },
      ];
      await expect(authenticator.authenticate(token.secret)).rejects.toThrow("tenant fields");
      expect(authenticator.credentialAdmission(token.secret)).toBeNull();
    }
  } finally {
    await authenticator.close();
    await database.close();
  }
});

test("in-flight authentication cannot repopulate admissions after shutdown", async (): Promise<void> => {
  const database: AuthenticationDatabase = new AuthenticationDatabase();
  const authenticator: HostedAuthenticator = new HostedAuthenticator(database.database);
  const token: HostedTokenSecret = generateTokenSecret("mur");
  const completion: {
    readonly promise: Promise<unknown>;
    readonly resolve: (value: unknown) => void;
  } = Promise.withResolvers<unknown>();
  database.result = completion.promise;
  try {
    const authentication: Promise<HostedPrincipal | null> = authenticator.authenticate(
      token.secret,
    );
    await authenticator.close();
    completion.resolve([tenantRow(token, TenantId.parse(randomUUID()))]);
    expect(await authentication).not.toBeNull();
    expect(authenticator.credentialAdmission(token.secret)).toBeNull();
  } finally {
    completion.resolve([]);
    await authenticator.close();
    await database.close();
  }
});
