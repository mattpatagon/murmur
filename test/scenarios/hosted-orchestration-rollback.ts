import { expect } from "bun:test";

import { type MessageDto, toMessageDto } from "../../src/domain/contracts.js";
import { AgentGeneration } from "../../src/domain/lifecycle-values.js";
import type { Message } from "../../src/domain/models.js";
import { AgentId, Sequence, TenantId } from "../../src/domain/value-objects.js";
import { type MurmurHttpServer, startHttpServer } from "../../src/http-server.js";
import type { MessageStore } from "../../src/storage/message-store.js";
import { PostgresMessageStore } from "../../src/storage/postgres-message-store.js";
import {
  callToolExpectingError,
  initialize,
  testTlsConfiguration,
  toolNames,
} from "../support/hosted-mcp-harness.js";

export async function verifyHostedOrchestrationRollback(
  configuredDatabaseUrl: string,
  options: {
    readonly bossAgentId: string;
    readonly bossSecret: string;
    readonly requestMessageId: string;
    readonly requestPolicyId: string;
    readonly tenantId: string;
  },
): Promise<void> {
  const server: MurmurHttpServer = await startHttpServer({
    MURMUR_API_TOKEN: "rollback-legacy-token-without-orchestrator-authority",
    MURMUR_AUTH_MODE: "hybrid",
    MURMUR_DATABASE_URL: configuredDatabaseUrl,
    MURMUR_HTTP_HOST: "127.0.0.1",
    ...(testTlsConfiguration.mode === "insecure" ? { MURMUR_DATABASE_TLS_INSECURE: "1" } : {}),
    PORT: "0",
  });
  let root: PostgresMessageStore | null = null;
  try {
    const session: string = await initialize(
      server.mcpUrl,
      options.bossSecret,
      "orchestrator-hybrid-rollback-test",
    );
    expect(await toolNames(server.mcpUrl, options.bossSecret, session)).toEqual([
      "check_for_upgrades",
    ]);
    expect(
      await callToolExpectingError(
        server.mcpUrl,
        options.bossSecret,
        session,
        600,
        "send_message",
        {
          content: "Must remain unavailable in hybrid mode",
          recipient_id: "forbidden",
          sender_id: "forbidden",
        },
      ),
    ).toContain("Unknown tool");
    root = await PostgresMessageStore.connect(configuredDatabaseUrl, testTlsConfiguration);
    const store: MessageStore = root.scope(TenantId.parse(options.tenantId));
    const messages: readonly Message[] = await store.getMessages({
      afterSequence: Sequence.zero(),
      agentId: AgentId.parse(options.bossAgentId),
      generation: AgentGeneration.parse(1),
      limit: 100,
      threadId: null,
      unreadOnly: false,
    });
    const retained: Message | undefined = messages.find(
      (message: Message): boolean => message.messageId.value === options.requestMessageId,
    );
    if (retained === undefined) throw new Error("Expected the retained orchestration request");
    const rendered: MessageDto = toMessageDto(retained);
    expect(rendered.sender_authority).toBe("peer");
    expect(rendered.message_kind).toBe("orchestration_request");
    expect(rendered.orchestrator_policy_id).toBe(options.requestPolicyId);
  } finally {
    const cleanup: Promise<unknown>[] = [server.stop()];
    if (root !== null) cleanup.push(root.close());
    await Promise.allSettled(cleanup);
  }
}
