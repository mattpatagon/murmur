import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type ClientRequest, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TenantId } from "../src/domain/value-objects.js";
import { HostedAuthenticator } from "../src/hosted/authenticator.js";
import type { CredentialAdmission, HostedPrincipal } from "../src/hosted/control-plane.js";
import {
  authenticateHostedCredential,
  type HostedAuthenticationResult,
} from "../src/http/hosted-credential-authentication.js";
import { HttpCapacityController, type TimeSource } from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  createDefaultHttpObservability,
  createHttpObservability,
  type HttpObservability,
  type RequestObservation,
} from "../src/observability/request-observation.js";
import { type LogOutput, StructuredLogger } from "../src/observability/structured-logger.js";
import { createTelemetry } from "../src/observability/telemetry.js";
import { requestHeaders, testEnvironment } from "./support/http-mcp-harness.js";

type Gate = { readonly promise: Promise<void>; resolve(): void };

class HeldAuthenticator extends HostedAuthenticator {
  public calls: number = 0;
  public readonly entered: Gate = Promise.withResolvers<void>();
  public readonly release: Gate = Promise.withResolvers<void>();

  public constructor() {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: null,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
  }

  public override credentialAdmission(token: string): CredentialAdmission {
    return { key: token, tenantKey: `tenant-${token}` };
  }

  public override async authenticate(_token: string): Promise<HostedPrincipal> {
    this.calls += 1;
    this.entered.resolve();
    await this.release.promise;
    return { kind: "tenant", role: "agent", tenantId: TenantId.founding(), tokenId: "fixture" };
  }
}

class QueueTime implements TimeSource {
  public readonly queued: Gate = Promise.withResolvers<void>();

  public now(): number {
    return 0;
  }

  public schedule(_milliseconds: number, _wake: () => void): () => void {
    this.queued.resolve();
    return (): void => {};
  }
}

class CompletionOutput implements LogOutput {
  public readonly errors: string[] = [];
  public readonly infos: string[] = [];

  public error(line: string): void {
    this.errors.push(line);
  }

  public info(line: string): void {
    this.infos.push(line);
  }
}

async function closeRequest(url: URL, token: string): Promise<Response> {
  return await fetch(url, {
    headers: requestHeaders("already-closed-fixture-session", token),
    method: "DELETE",
    signal: AbortSignal.timeout(2_000),
  });
}

async function tokenRequest(url: URL, token: string): Promise<Response> {
  return await fetch(new URL("/oauth/token", url), {
    body: new URLSearchParams({ client_id: "murmur", client_secret: token }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
}

for (const scenario of [
  { name: "credential burst", token: "first", status: 429, scope: "credential", oauth: false },
  { name: "global saturation", token: "third", status: 503, scope: "global", oauth: false },
  { name: "OAuth credential burst", token: "first", status: 429, scope: "credential", oauth: true },
  { name: "OAuth global saturation", token: "third", status: 503, scope: "global", oauth: true },
]) {
  test(`HTTP authentication ${scenario.name} preserves retry and log classification`, async (): Promise<void> => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-auth-burst-"));
    const authenticator: HeldAuthenticator = new HeldAuthenticator();
    const time: QueueTime = new QueueTime();
    const output: CompletionOutput = new CompletionOutput();
    const environment: NodeJS.ProcessEnv = {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_LOG_LEVEL: "info",
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS: "1",
      MURMUR_OAUTH_PUBLIC_ORIGIN: "https://murmur.test",
    };
    const server: MurmurHttpServer = await startHttpServer(environment, {
      authenticator,
      timeSource: time,
      observability: createHttpObservability(
        new StructuredLogger(environment, output),
        createTelemetry(environment),
      ),
    });
    let first: Promise<Response> | null = null;
    let second: Promise<Response> | null = null;
    try {
      first = closeRequest(server.mcpUrl, "first");
      await authenticator.entered.promise;
      second = closeRequest(server.mcpUrl, "second");
      await time.queued.promise;
      const rejected: Response = await (scenario.oauth ? tokenRequest : closeRequest)(
        server.mcpUrl,
        scenario.token,
      );
      expect(rejected.status).toBe(scenario.status);
      expect(rejected.headers.get("retry-after")).toBe("1");
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(await rejected.json()).toEqual(
        scenario.oauth
          ? {
              error: "temporarily_unavailable",
              error_description: "Authentication service is busy",
            }
          : { error: "Authentication capacity reached" },
      );
      expect(authenticator.calls).toBe(1);
      const lines: readonly string[] = scenario.status === 429 ? output.infos : output.errors;
      expect(
        lines.some(
          (line: string): boolean =>
            line.includes(`"http_status_code":${scenario.status}`) &&
            line.includes(`"authentication_capacity_scope":"${scenario.scope}"`) &&
            line.includes(
              `"outcome":"${scenario.status === 429 ? "client_error" : "server_error"}"`,
            ),
        ),
      ).toBe(true);
      expect(output.errors.length).toBe(scenario.status === 429 ? 0 : 1);
      authenticator.release.resolve();
      const accepted: Response[] = await Promise.all([first, second]);
      for (const response of accepted) {
        expect(response.status).toBe(404);
        await response.text();
      }
      const recovery: Response = await closeRequest(server.mcpUrl, scenario.token);
      expect(recovery.status).toBe(404);
      await recovery.text();
      expect(authenticator.calls).toBe(3);
    } finally {
      authenticator.release.resolve();
      for (const pending of [first, second]) {
        if (pending !== null) {
          const response: Response = await pending;
          if (!response.bodyUsed) await response.text();
        }
      }
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("abandoned queued credentials never authenticate and their pending slot is reusable", async (): Promise<void> => {
  const authenticator: HeldAuthenticator = new HeldAuthenticator();
  const time: QueueTime = new QueueTime();
  const capacity: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS: "1",
    }),
    time,
  );
  const observation: RequestObservation = createDefaultHttpObservability({
    MURMUR_LOG_LEVEL: "off",
  }).observe(new Request("http://localhost/mcp"));
  const controller: AbortController = new AbortController();
  const first: Promise<HostedAuthenticationResult> = authenticateHostedCredential(
    "first",
    authenticator,
    capacity,
    observation,
    new AbortController().signal,
  );
  let recovered: Promise<HostedAuthenticationResult> | null = null;
  try {
    await authenticator.entered.promise;
    const abandoned: Promise<HostedAuthenticationResult> = authenticateHostedCredential(
      "second",
      authenticator,
      capacity,
      observation,
      controller.signal,
    );
    await time.queued.promise;
    controller.abort();
    expect(await abandoned).toEqual({ kind: "cancelled" });
    expect(authenticator.calls).toBe(1);
    recovered = authenticateHostedCredential(
      "third",
      authenticator,
      capacity,
      observation,
      new AbortController().signal,
    );
    authenticator.release.resolve();
    expect((await first).kind).toBe("authenticated");
    expect((await recovered).kind).toBe("authenticated");
    expect(authenticator.calls).toBe(2);
  } finally {
    controller.abort();
    authenticator.release.resolve();
    await first;
    if (recovered !== null) await recovered;
    capacity.stop();
    await authenticator.close();
  }
});

for (const oauth of [false, true]) {
  test(`aborted queued ${oauth ? "OAuth" : "MCP"} HTTP requests release admission`, async (): Promise<void> => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-auth-abort-"));
    const authenticator: HeldAuthenticator = new HeldAuthenticator();
    const queued: Gate = Promise.withResolvers<void>();
    const replacementQueued: Gate = Promise.withResolvers<void>();
    const cancelled: Gate = Promise.withResolvers<void>();
    let waits: number = 0;
    const time: TimeSource = {
      now: (): number => 0,
      schedule: (milliseconds: number, _wake: () => void): (() => void) => {
        if (milliseconds === 11) {
          waits += 1;
          if (waits === 1) queued.resolve();
          if (waits === 2) replacementQueued.resolve();
        }
        return (): void => {};
      },
    };
    const environment: NodeJS.ProcessEnv = {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_AUTHENTICATION_WAIT_MS: "11",
      MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
      MURMUR_MAX_PENDING_AUTHENTICATIONS: "1",
      MURMUR_OAUTH_PUBLIC_ORIGIN: "https://murmur.test",
    };
    const base: HttpObservability = createDefaultHttpObservability(environment);
    const server: MurmurHttpServer = await startHttpServer(environment, {
      authenticator,
      timeSource: time,
      observability: {
        ...base,
        observe: (incoming: Request): RequestObservation => {
          const observation: RequestObservation = base.observe(incoming);
          return new Proxy<RequestObservation>(observation, {
            get: (target: RequestObservation, key: string | symbol): unknown => {
              if (key === "track") {
                return (response: Response): Response => {
                  if (response.status === 408) cancelled.resolve();
                  return target.track(response);
                };
              }
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    });
    let first: Promise<Response> | null = null;
    let replacement: Promise<Response> | null = null;
    let abandoned: ClientRequest | null = null;
    try {
      first = closeRequest(server.mcpUrl, "first");
      await authenticator.entered.promise;
      const body: string = new URLSearchParams({
        client_id: "murmur",
        client_secret: "abandoned",
      }).toString();
      abandoned = request(oauth ? new URL("/oauth/token", server.mcpUrl) : server.mcpUrl, {
        method: oauth ? "POST" : "DELETE",
        headers: oauth
          ? {
              "content-type": "application/x-www-form-urlencoded",
              "content-length": Buffer.byteLength(body),
            }
          : Object.fromEntries(requestHeaders("already-closed-fixture-session", "abandoned")),
      });
      abandoned.on("error", (_error: Error): void => {});
      abandoned.end(oauth ? body : undefined);
      await queued.promise;
      abandoned.destroy();
      await cancelled.promise;
      expect(authenticator.calls).toBe(1);
      replacement = closeRequest(server.mcpUrl, "replacement");
      await replacementQueued.promise;
      expect(authenticator.calls).toBe(1);
      authenticator.release.resolve();
      for (const response of await Promise.all([first, replacement])) {
        expect(response.status).toBe(404);
        await response.text();
      }
      expect(authenticator.calls).toBe(2);
    } finally {
      if (abandoned !== null) abandoned.destroy();
      authenticator.release.resolve();
      for (const pending of [first, replacement]) {
        if (pending !== null) {
          const response: Response = await pending;
          if (!response.bodyUsed) await response.text();
        }
      }
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 8_000);
}
