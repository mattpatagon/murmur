import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProductionStreamConfig,
  ProductionStreamRuntime,
} from "../scripts/lib/production-stream-contracts.js";
import {
  type ProductionStreamControl,
  ProductionStreamFixture,
} from "../scripts/lib/production-stream-fixture.js";
import { PRODUCTION_STREAM_CLOCK } from "../scripts/lib/production-stream-io.js";
import {
  type IssuedTokenDto,
  type TokenSummaryDto,
  toIssuedTokenDto,
} from "../src/hosted/contracts.js";
import { issueSelfServiceToken, selfServiceTenantId } from "../src/hosted/token-issuance.js";
import { generateTokenSecret, type HostedTokenSecret } from "../src/hosted/token-secret.js";

type Options = {
  readonly loseSignup?: boolean | undefined;
  readonly loseMint?: boolean | undefined;
  readonly wrongTenant?: boolean | undefined;
  readonly retainWorker?: boolean | undefined;
  readonly failClose?: boolean | undefined;
};
type Fixture = {
  readonly fixture: ProductionStreamFixture;
  readonly events: string[];
  readonly signupBodies: string[];
  readonly ownTenant: () => string;
  readonly suspendedTenant: () => string | null;
};

function fixture(options: Options = {}): Fixture {
  const events: string[] = [];
  const signupBodies: string[] = [];
  let admin: IssuedTokenDto | null = null;
  let worker: IssuedTokenDto | null = null;
  let tenantId: string = "";
  let suspended: string | null = null;
  const revoked: Set<string> = new Set<string>();
  const config: ProductionStreamConfig = {
    endpoint: new URL("https://observer.invalid/mcp"),
    expectedSha: "a".repeat(40),
    expectedVersion: "0.14.0.0",
    operatorToken: `mur_op_operator_${"a".repeat(43)}`,
  };
  const runtime: ProductionStreamRuntime = {
    clock: PRODUCTION_STREAM_CLOCK,
    fetch: async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init === undefined || init.signal === undefined || init.signal === null)
        throw new Error("missing request scope");
      init.signal.throwIfAborted();
      expect(init.redirect).toBe("error");
      if (new URL(url).pathname === "/v1/tenants") {
        if (typeof init.body !== "string") throw new Error("missing signup body");
        signupBodies.push(init.body);
        const input: { slug: string; display_name: string; registration_secret: string } = z
          .object({
            slug: z.string(),
            display_name: z.string(),
            registration_secret: z.string(),
          })
          .parse(JSON.parse(init.body));
        tenantId = selfServiceTenantId(input.registration_secret).value;
        admin = toIssuedTokenDto(
          issueSelfServiceToken(
            selfServiceTenantId(input.registration_secret),
            input.registration_secret,
          ).token,
        );
        if (options.loseSignup === true && signupBodies.length === 1)
          throw new Error("response lost after commit");
        return Response.json(
          {
            tenant: {
              tenant_id: options.wrongTenant === true ? randomUUID() : tenantId,
              slug: input.slug,
              display_name: input.display_name,
              status: "active",
              suspended_at: null,
              created_at: "2026-09-05T00:00:00.000Z",
            },
            token: admin,
          },
          { status: 201 },
        );
      }
      expect(new URL(url).pathname).toBe("/mcp");
      expect(init.method).toBe("GET");
      const credential: string | null = new Headers(init.headers).get("authorization");
      const token: IssuedTokenDto | null =
        worker !== null && credential === `Bearer ${worker.secret}` ? worker : admin;
      if (token === null || credential !== `Bearer ${token.secret}`)
        throw new Error("foreign credential probe");
      events.push(token.role === "agent" ? "verify-worker" : "verify-admin");
      expect(suspended).toBe(null);
      return new Response(null, {
        status: revoked.has(token.key_id) ? 401 : 400,
        headers: { "www-authenticate": 'Bearer realm="murmur"' },
      });
    },
  };
  const connection: (secret: string) => ProductionStreamControl = (
    secret: string,
  ): ProductionStreamControl => {
    const operator: boolean = secret === config.operatorToken;
    if (!operator && (admin === null || admin.secret !== secret))
      throw new Error("foreign administrator credential");
    const ensureSignal: (signal: AbortSignal | undefined) => void = (
      signal: AbortSignal | undefined,
    ): void => {
      if (signal === undefined) throw new Error("unscoped administrative operation");
      signal.throwIfAborted();
    };
    const summary: (token: IssuedTokenDto) => TokenSummaryDto = (
      token: IssuedTokenDto,
    ): TokenSummaryDto => ({
      agent_id: token.agent_id,
      created_at: "2026-09-05T00:00:00.000Z",
      expires_at: token.expires_at,
      key_id: token.key_id,
      last_used_at: null,
      machine: token.machine,
      name: token.name,
      personal_id: token.personal_id,
      repository: token.repository,
      revoked_at: revoked.has(token.key_id) ? "2026-09-05T01:00:00.000Z" : null,
      role: token.role,
      token_id: token.token_id,
    });
    return {
      connect: async (signal?: AbortSignal): Promise<void> => {
        ensureSignal(signal);
        events.push(operator ? "connect-operator" : "connect-admin");
      },
      close: async (): Promise<void> => {
        events.push("close");
        if (options.failClose === true) throw new Error("private cleanup details");
      },
      call: async <T>(
        name: string,
        _input: Record<string, unknown>,
        schema: z.ZodType<T>,
        signal?: AbortSignal,
      ): Promise<T> => {
        ensureSignal(signal);
        expect(operator).toBe(false);
        expect(name).toBe("list_access_tokens");
        events.push("list-own-tokens");
        return schema.parse({
          next_cursor: null,
          tokens: worker === null ? [] : [summary(worker)],
        });
      },
      approved: async <T>(
        name: "create_access_token" | "revoke_access_token" | "suspend_tenant",
        input: Record<string, unknown>,
        schema: z.ZodType<T>,
        signal?: AbortSignal,
      ): Promise<T> => {
        ensureSignal(signal);
        if (name === "suspend_tenant") {
          expect(operator).toBe(true);
          expect(input["tenant_id"]).toBe(tenantId);
          events.push("suspend");
          suspended = tenantId;
          return schema.parse({ changed: true });
        }
        expect(operator).toBe(false);
        if (name === "create_access_token") {
          // Explicit identities must already exist in this tenant, as PostgreSQL enforces.
          if (admin === null || input["personal_id"] !== admin.personal_id)
            throw new Error("The personal identity is unavailable in this tenant");
          events.push("mint-worker");
          const material: HostedTokenSecret = generateTokenSecret("mur");
          worker = {
            agent_id: null,
            expires_at: z.string().parse(input["expires_at"]),
            key_id: material.keyId,
            machine: null,
            name: z.string().parse(input["name"]),
            personal_id: z.string().uuid().parse(input["personal_id"]),
            repository: z.literal("canary/production-stream").parse(input["repository"]),
            role: "agent",
            secret: material.secret,
            tenant_id: tenantId,
            token_id: randomUUID(),
          };
          if (options.loseMint === true) throw new Error("mint committed but response lost");
          return schema.parse({ token: worker });
        }
        const key: string = z.string().parse(input["key_id"]);
        const isWorker: boolean = worker !== null && key === worker.key_id;
        expect(isWorker || (admin !== null && key === admin.key_id)).toBe(true);
        events.push(isWorker ? "revoke-worker" : "revoke-admin");
        if (!(isWorker && options.retainWorker === true)) revoked.add(key);
        return schema.parse({ revoked: !(isWorker && options.retainWorker === true) });
      },
    };
  };
  return {
    fixture: new ProductionStreamFixture(config, runtime, connection),
    events,
    signupBodies,
    ownTenant: (): string => tenantId,
    suspendedTenant: (): string | null => suspended,
  };
}

test("lost signup response retries the exact derived fixture, never the tenant directory", async (): Promise<void> => {
  const value: Fixture = fixture({ loseSignup: true });
  await value.fixture.provision(new AbortController().signal);
  const result: Awaited<ReturnType<typeof value.fixture.cleanup>> = await value.fixture.cleanup();
  expect(value.signupBodies.length).toBe(2);
  expect(value.signupBodies[0]).toBe(value.signupBodies[1]);
  expect(value.events).not.toContain("list-own-tokens");
  expect(value.suspendedTenant()).toBe(value.ownTenant());
  expect(Object.values(result).every((item: boolean): boolean => item)).toBe(true);
  expect(value.events.indexOf("verify-worker")).toBeLessThan(value.events.indexOf("revoke-admin"));
  expect(value.events.indexOf("verify-admin")).toBeLessThan(value.events.indexOf("suspend"));
});

test("lost worker mint response recovers only that owned token, revokes it, and still suspends without claiming unknown-secret 401", async (): Promise<void> => {
  const value: Fixture = fixture({ loseMint: true });
  await expect(value.fixture.provision(new AbortController().signal)).rejects.toThrow();
  const result: Awaited<ReturnType<typeof value.fixture.cleanup>> = await value.fixture.cleanup();
  expect(value.events.filter((event: string): boolean => event === "mint-worker")).toHaveLength(1);
  expect(value.events).toContain("list-own-tokens");
  expect(result.worker_revoked).toBe(true);
  expect(result.worker_unauthorized).toBe(false);
  expect(result.tenant_suspended).toBe(true);
});

test("a foreign signup result is never adopted and cleanup remains on the locally derived own tenant", async (): Promise<void> => {
  const value: Fixture = fixture({ wrongTenant: true });
  await expect(value.fixture.provision(new AbortController().signal)).rejects.toThrow();
  await value.fixture.cleanup();
  expect(value.events).not.toContain("mint-worker");
  expect(value.suspendedTenant()).toBe(value.ownTenant());
});

test("suspension cannot conceal failure to revoke the target worker", async (): Promise<void> => {
  const value: Fixture = fixture({ retainWorker: true });
  await value.fixture.provision(new AbortController().signal);
  const result: Awaited<ReturnType<typeof value.fixture.cleanup>> = await value.fixture.cleanup();
  expect(result.worker_revoked).toBe(false);
  expect(result.worker_unauthorized).toBe(false);
  expect(result.tenant_suspended).toBe(true);
  expect(result.connections_closed).toBe(true);
});
