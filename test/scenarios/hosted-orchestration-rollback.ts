import { expect } from "bun:test";

import { type MurmurHttpServer, startHttpServer } from "../../src/http-server.js";
import {
  callToolExpectingError,
  initialize,
  testTlsConfiguration,
  toolNames,
} from "../support/hosted-mcp-harness.js";

export async function verifyHostedOrchestrationRollback(
  configuredDatabaseUrl: string,
  bossSecret: string,
): Promise<void> {
  const server: MurmurHttpServer = await startHttpServer({
    MURMUR_API_TOKEN: "rollback-legacy-token-without-orchestrator-authority",
    MURMUR_AUTH_MODE: "hybrid",
    MURMUR_DATABASE_URL: configuredDatabaseUrl,
    MURMUR_HTTP_HOST: "127.0.0.1",
    ...(testTlsConfiguration.mode === "insecure" ? { MURMUR_DATABASE_TLS_INSECURE: "1" } : {}),
    PORT: "0",
  });
  try {
    const session: string = await initialize(
      server.mcpUrl,
      bossSecret,
      "orchestrator-hybrid-rollback-test",
    );
    expect(await toolNames(server.mcpUrl, bossSecret, session)).toEqual([]);
    expect(
      await callToolExpectingError(server.mcpUrl, bossSecret, session, 600, "send_message", {
        content: "Must remain unavailable in hybrid mode",
        recipient_id: "forbidden",
        sender_id: "forbidden",
      }),
    ).toContain("cannot access tenant data");
  } finally {
    await server.stop();
  }
}
