import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostedAuthenticator } from "../src/hosted/authenticator.js";
import type { HostedPrincipal } from "../src/hosted/control-plane.js";
import {
  createHostedMurmurApplication,
  type HostedApplicationRequest,
} from "../src/http/murmur-application-factory.js";
import { responseWithFinish } from "../src/http/response-lifecycle.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import type { MurmurApplication } from "../src/mcp/murmur-application.js";
import {
  createDefaultHttpObservability,
  type GateOutcome,
  type HttpObservability,
  type RequestObservation,
} from "../src/observability/request-observation.js";
import {
  initializeRequest,
  requestHeaders,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

const TOKEN: string = ["test", "deferred", "ingress", "credential"].join("-");
const MAX_BODY_BYTES: number = 256;
type Gate = { readonly promise: Promise<void>; resolve(): void };

class DeferredAuthenticator extends HostedAuthenticator {
  public readonly entered: Gate = Promise.withResolvers<void>();
  public readonly released: Gate = Promise.withResolvers<void>();
  public calls: number = 0;
  public active: number = 0;
  public settled: number = 0;
  public identities: number = 0;
  public closes: number = 0;

  public constructor() {
    super({
      allowBootstrap: false,
      controlPlane: null,
      legacyToken: TOKEN,
      mode: "legacy",
      tenantOnboardingEnabled: false,
    });
  }

  public override async authenticate(token: string): Promise<HostedPrincipal | null> {
    this.calls += 1;
    this.active += 1;
    try {
      if (this.calls === 1) {
        this.entered.resolve();
        await this.released.promise;
      }
      return await super.authenticate(token);
    } finally {
      this.active -= 1;
      this.settled += 1;
    }
  }

  public override identity(principal: HostedPrincipal): string {
    this.identities += 1;
    return super.identity(principal);
  }

  public override async close(): Promise<void> {
    this.closes += 1;
    await super.close();
  }
}

type ObservedLifetime = {
  readonly finished: Gate;
  readonly requests: Request[];
  admissions: number;
};

function observeLifetimes(
  environment: NodeJS.ProcessEnv,
  state: ObservedLifetime,
): HttpObservability {
  const base: HttpObservability = createDefaultHttpObservability(environment);
  return {
    ...base,
    observe: (request: Request): RequestObservation => {
      state.requests.push(request);
      const observation: RequestObservation = base.observe(request);
      return new Proxy<RequestObservation>(observation, {
        get: (target: RequestObservation, key: string | symbol): unknown => {
          if (key === "recordRequestCapacity") {
            return (outcome: GateOutcome): void => {
              state.admissions += 1;
              target.recordRequestCapacity(outcome);
            };
          }
          if (key === "track") {
            return (response: Response): Response =>
              responseWithFinish(target.track(response), (): void => state.finished.resolve());
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

function responseUntilEnd(socket: Socket): Promise<string> {
  return new Promise<string>(
    (resolve: (text: string) => void, reject: (error: Error) => void): void => {
      let received: string = "";
      const deadline: ReturnType<typeof setTimeout> = setTimeout(
        (): void => reject(new Error("Ingress rejection response did not end")),
        2_000,
      );
      socket.on("data", (chunk: Buffer): void => {
        received += chunk.toString("latin1");
        if (received.length > 4_096) {
          clearTimeout(deadline);
          reject(new Error("Unexpected rejection response size"));
        }
      });
      socket.once("error", (error: Error): void => {
        clearTimeout(deadline);
        reject(error);
      });
      socket.once("end", (): void => {
        clearTimeout(deadline);
        resolve(received);
      });
    },
  );
}

test("real HTTP ingress overflow retains authentication work but never enters post-auth parsing", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-ingress-auth-lifetime-"));
  const authenticator: DeferredAuthenticator = new DeferredAuthenticator();
  const lifetime: ObservedLifetime = {
    finished: Promise.withResolvers<void>(),
    requests: [],
    admissions: 0,
  };
  const environment: NodeJS.ProcessEnv = {
    ...testEnvironment(join(directory, "messages.db")),
    MURMUR_MAX_REQUEST_BYTES: String(MAX_BODY_BYTES),
    MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "1",
    MURMUR_MAX_ACTIVE_REQUESTS: "1",
    MURMUR_RATE_LIMIT_PER_MINUTE: "1",
  };
  let applications: number = 0;
  let server: MurmurHttpServer | null = null;
  const client: Socket = new Socket();
  try {
    server = await startHttpServer(environment, {
      authenticator,
      observability: observeLifetimes(environment, lifetime),
      applicationFactory: async (request: HostedApplicationRequest): Promise<MurmurApplication> => {
        applications += 1;
        return await createHostedMurmurApplication(request);
      },
    });
    const rawResponse: Promise<string> = responseUntilEnd(client);
    const port: number = server.port;
    await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      client.once("error", reject);
      client.connect({ host: "127.0.0.1", port }, (): void => {
        client.off("error", reject);
        resolve();
      });
    });
    client.write(
      [
        "POST /mcp HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        `Authorization: Bearer ${TOKEN}`,
        "Content-Type: application/json",
        "Accept: application/json, text/event-stream",
        "Transfer-Encoding: chunked",
        "",
        "",
      ].join("\r\n"),
    );
    await authenticator.entered.promise;
    expect(authenticator.active).toBe(1);
    expect(lifetime.requests).toHaveLength(1);
    const abandonedRequest: Request | undefined = lifetime.requests[0];
    if (abandonedRequest === undefined) throw new Error("The application request was not observed");
    expect(abandonedRequest.bodyUsed).toBe(false);
    client.write(`${(MAX_BODY_BYTES + 1).toString(16)}\r\n${"a".repeat(MAX_BODY_BYTES + 1)}\r\n`);
    const raw: string = await rawResponse;
    expect(raw.startsWith("HTTP/1.1 413")).toBe(true);
    expect(raw.toLowerCase()).toContain("connection: close");
    expect(raw).toContain('{"error":"HTTP request body exceeds its limit"}');
    expect(raw).not.toContain(TOKEN);
    expect(abandonedRequest.signal.aborted).toBe(true);
    expect(authenticator.active).toBe(1);
    expect(authenticator.settled).toBe(0);
    expect(authenticator.identities).toBe(0);
    expect(lifetime.admissions).toBe(0);
    expect(applications).toBe(0);

    authenticator.released.resolve();
    await lifetime.finished.promise;
    expect(authenticator.active).toBe(0);
    expect(authenticator.settled).toBe(1);
    expect(authenticator.identities).toBe(0);
    expect(lifetime.admissions).toBe(0);
    expect(abandonedRequest.bodyUsed).toBe(false);
    expect(applications).toBe(0);

    const body: string = JSON.stringify(initializeRequest(1));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const recovery: Response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: requestHeaders(null, TOKEN),
      body,
      signal: AbortSignal.timeout(2_000),
    });
    expect(recovery.status).toBe(200);
    expect(recovery.headers.get("mcp-session-id")).not.toBeNull();
    expect(await responsePayload(recovery)).toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      result: { serverInfo: { name: "murmur" } },
    });
    expect(authenticator.calls).toBe(2);
    expect(authenticator.settled).toBe(2);
    expect(authenticator.active).toBe(0);
    expect(authenticator.identities).toBe(1);
    expect(lifetime.admissions).toBe(1);
    expect(applications).toBe(1);
  } finally {
    authenticator.released.resolve();
    client.destroy();
    if (server !== null) await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(authenticator.closes).toBe(1);
}, 8_000);
