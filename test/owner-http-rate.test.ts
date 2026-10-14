import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  initializeRequest,
  postJson,
  responsePayload,
  testEnvironment,
} from "./support/http-mcp-harness.js";

for (const enabled of [false, true]) {
  test(`authenticated owner rate priority ${enabled} preserves its explicit ceiling`, async (): Promise<void> => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-owner-rate-"));
    let server: MurmurHttpServer | null = null;
    try {
      server = await startHttpServer({
        ...testEnvironment(join(directory, "messages.sqlite")),
        MURMUR_OWNER_PRIORITY: enabled ? "1" : "0",
        MURMUR_RATE_LIMIT_PER_MINUTE: "2",
        MURMUR_TENANT_RATE_LIMIT_PER_MINUTE: "4",
      });
      const initialized: Response = await postJson(server.mcpUrl, initializeRequest(1), null);
      expect(initialized.status).toBe(200);
      const sessionId: string | null = initialized.headers.get("mcp-session-id");
      if (sessionId === null) throw new Error("Owner session was not initialized");
      await responsePayload(initialized);
      const notification: Response = await postJson(
        server.mcpUrl,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
      );
      expect(notification.status).toBe(202);
      await notification.text();
      for (let index: number = 0; index < (enabled ? 2 : 0); index += 1) {
        const ping: Response = await postJson(
          server.mcpUrl,
          { id: index + 2, jsonrpc: "2.0", method: "ping" },
          sessionId,
        );
        expect(ping.status).toBe(200);
        await responsePayload(ping);
      }
      const rejected: Response = await postJson(
        server.mcpUrl,
        { id: 5, jsonrpc: "2.0", method: "ping" },
        sessionId,
      );
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("60");
      expect(await rejected.json()).toEqual({ error: "Rate limit exceeded" });
    } finally {
      if (server !== null) await server.stop();
      rmSync(directory, { force: true, recursive: true });
    }
  });
}
