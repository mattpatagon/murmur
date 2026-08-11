import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TenantId } from "../src/domain/value-objects.js";
import {
  createHostedMurmurApplication,
  type HostedApplicationRequest,
} from "../src/http/murmur-application-factory.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import type { MurmurApplication } from "../src/mcp/murmur-application.js";
import {
  initializeRequest,
  initializeSession,
  postJson,
  testEnvironment,
} from "./support/http-mcp-harness.js";

type Barrier = {
  readonly entered: Promise<HostedApplicationRequest>;
  readonly release: () => void;
};

function applicationBarrier(): Barrier & {
  readonly factory: (request: HostedApplicationRequest) => Promise<MurmurApplication>;
} {
  let enter: ((request: HostedApplicationRequest) => void) | undefined;
  let release: (() => void) | undefined;
  const entered: Promise<HostedApplicationRequest> = new Promise<HostedApplicationRequest>(
    (resolve: (request: HostedApplicationRequest) => void): void => {
      enter = resolve;
    },
  );
  const released: Promise<void> = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  if (enter === undefined || release === undefined)
    throw new Error("Barrier initialization failed");
  const notifyEntered: (request: HostedApplicationRequest) => void = enter;
  const releaseFactory: () => void = release;
  let first: boolean = true;
  return {
    entered,
    factory: async (request: HostedApplicationRequest): Promise<MurmurApplication> => {
      if (first) {
        first = false;
        notifyEntered(request);
        await released;
      }
      return await createHostedMurmurApplication(request);
    },
    release: releaseFactory,
  };
}

test("tenant invalidation rejects an initialization that captured stale authorization", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-session-invalidation-"));
  const barrier: ReturnType<typeof applicationBarrier> = applicationBarrier();
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
    { applicationFactory: barrier.factory },
  );
  try {
    const initialization: Promise<Response> = postJson(
      server.mcpUrl,
      initializeRequest(1, "stale-initializer"),
      null,
    );
    const request: HostedApplicationRequest = await barrier.entered;
    const tenantId: TenantId | null =
      request.principal.kind === "tenant" ? request.principal.tenantId : null;
    if (tenantId === null) throw new Error("Test initialization did not authenticate a tenant");
    await request.onTenantSuspended(tenantId);
    barrier.release();

    const rejected: Response = await initialization;
    expect(rejected.status).toBe(409);
    expect(rejected.headers.get("mcp-session-id")).toBeNull();
    expect(await rejected.json()).toEqual({
      error: "MCP session authorization changed during initialization; retry",
    });

    const retrySessionId: string = await initializeSession(server.mcpUrl, "fresh-initializer");
    const usable: Response = await postJson(
      server.mcpUrl,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      retrySessionId,
    );
    expect(usable.status).toBe(200);
  } finally {
    barrier.release();
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
