import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHostedMurmurApplication,
  type HostedApplicationRequest,
} from "../src/http/murmur-application-factory.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import type { MurmurApplication } from "../src/mcp/murmur-application.js";
import { initializeRequest, postJson, testEnvironment } from "./support/http-mcp-harness.js";

for (const limit of ["MURMUR_MAX_SESSIONS", "MURMUR_MAX_SESSIONS_PER_TENANT"]) {
  test(`${limit} includes applications awaiting asynchronous initialization`, async (): Promise<void> => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-session-admission-"));
    const entered: { readonly promise: Promise<void>; readonly resolve: () => void } =
      Promise.withResolvers<void>();
    const released: { readonly promise: Promise<void>; readonly resolve: () => void } =
      Promise.withResolvers<void>();
    let creations: number = 0;
    const server: MurmurHttpServer = await startHttpServer(
      { ...testEnvironment(join(directory, "messages.db")), [limit]: "1" },
      {
        applicationFactory: async (
          request: HostedApplicationRequest,
        ): Promise<MurmurApplication> => {
          creations += 1;
          if (creations === 1) {
            entered.resolve();
            await released.promise;
          }
          return await createHostedMurmurApplication(request);
        },
      },
    );
    const first: Promise<Response> = postJson(server.mcpUrl, initializeRequest(1), null);
    try {
      await entered.promise;
      const overflow: Response = await postJson(server.mcpUrl, initializeRequest(2), null);
      expect(overflow.status).toBe(503);
      expect(await overflow.json()).toEqual({
        error:
          limit === "MURMUR_MAX_SESSIONS"
            ? "MCP session capacity reached"
            : "Tenant MCP session capacity reached",
      });
      expect(creations).toBe(1);
      released.resolve();
      const accepted: Response = await first;
      expect(accepted.status).toBe(200);
      await accepted.text();
    } finally {
      released.resolve();
      await first;
      await server.stop();
      rmSync(directory, { force: true, recursive: true });
    }
  });
}

test("failed application creation releases the reserved session slot", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-session-admission-failure-"));
  let fail: boolean = true;
  const server: MurmurHttpServer = await startHttpServer(
    {
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_MAX_SESSIONS: "1",
      MURMUR_MAX_SESSIONS_PER_TENANT: "1",
    },
    {
      applicationFactory: async (request: HostedApplicationRequest): Promise<MurmurApplication> => {
        if (fail) {
          fail = false;
          throw new Error("Injected application creation failure");
        }
        return await createHostedMurmurApplication(request);
      },
    },
  );
  try {
    const failed: Response = await postJson(server.mcpUrl, initializeRequest(1), null);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Internal server error" });
    const retry: Response = await postJson(server.mcpUrl, initializeRequest(2), null);
    expect(retry.status).toBe(200);
    await retry.text();
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
