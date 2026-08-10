import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent, BroadcastMessageResult, SendMessageResult } from "../src/domain/models.js";
import { OrchestratorPolicyId } from "../src/domain/orchestration.js";
import { AgentId, DisplayName } from "../src/domain/value-objects.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import {
  baseBroadcastCommand,
  baseMessageCommand,
  type StoreFixture,
  withFixture,
} from "./support/store-fixture.js";

test("SQLite reports peer provenance and rejects attempts to self-claim authority", (): void => {
  withFixture((fixture: StoreFixture): void => {
    const sent: SendMessageResult = fixture.store.sendMessage(baseMessageCommand());
    expect(sent.message.senderAuthority).toBe("peer");
    expect(sent.message.messageKind).toBe("message");
    expect(sent.message.orchestratorPolicyId).toBeNull();
    const alice: Agent | null = fixture.store.getAgent(AgentId.parse("alice"));
    if (alice === null) throw new Error("Expected Alice");
    expect(alice.authority).toBe("peer");

    expect((): void => {
      fixture.store.registerAgent({
        agentId: AgentId.parse("boss"),
        authority: "orchestrator",
        displayName: DisplayName.parse("Boss"),
        metadata: {},
      });
    }).toThrow("cannot register orchestrator authority");
    expect(
      (): SendMessageResult =>
        fixture.store.sendMessage({
          ...baseMessageCommand(),
          provenance: {
            messageKind: "message",
            orchestratorPolicyId: null,
            senderAuthority: "orchestrator",
          },
        }),
    ).toThrow("cannot persist orchestrator provenance");
    expect(
      (): SendMessageResult =>
        fixture.store.sendMessage({
          ...baseMessageCommand(),
          provenance: {
            messageKind: "orchestration_request",
            orchestratorPolicyId: OrchestratorPolicyId.parse(
              "10000000-0000-4000-8000-000000000001",
            ),
            senderAuthority: "peer",
          },
        }),
    ).toThrow("cannot persist orchestrator provenance");
    expect(
      (): BroadcastMessageResult =>
        fixture.store.broadcastMessage({
          ...baseBroadcastCommand(),
          senderAuthority: "orchestrator",
        }),
    ).toThrow("cannot persist orchestrator authority");
  });
});

test("SQLite provenance columns are immutable while read state remains mutable", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-authority-"));
  const databasePath: string = join(directory, "messages.db");
  const store: SqliteMessageStore = new SqliteMessageStore(databasePath);
  let messageId: string = "";
  let broadcastId: string = "";
  try {
    store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("Alice"),
      metadata: {},
    });
    store.registerAgent({
      agentId: AgentId.parse("bob"),
      displayName: DisplayName.parse("Bob"),
      metadata: {},
    });
    messageId = store.sendMessage(baseMessageCommand()).message.messageId.value;
    broadcastId = store.broadcastMessage(baseBroadcastCommand()).broadcastId.value;
  } finally {
    store.close();
  }

  const database: Database = new Database(databasePath);
  try {
    expect((): unknown =>
      database.query("UPDATE agents SET authority = 'orchestrator' WHERE agent_id = 'alice'").run(),
    ).toThrow();
    expect((): unknown =>
      database
        .query("UPDATE broadcasts SET sender_authority = 'orchestrator' WHERE broadcast_id = ?")
        .run(broadcastId),
    ).toThrow();
    expect((): unknown =>
      database
        .query("UPDATE messages SET sender_authority = 'orchestrator' WHERE message_id = ?")
        .run(messageId),
    ).toThrow();
    expect((): unknown =>
      database
        .query("UPDATE messages SET message_kind = 'orchestration_request' WHERE message_id = ?")
        .run(messageId),
    ).toThrow();
    expect((): unknown =>
      database
        .query(
          "UPDATE messages SET orchestrator_policy_id = '10000000-0000-4000-8000-000000000001' WHERE message_id = ?",
        )
        .run(messageId),
    ).toThrow();
    expect(
      database
        .query("UPDATE messages SET read_at = '2026-08-10T12:00:00.000Z' WHERE message_id = ?")
        .run(messageId).changes,
    ).toBe(1);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
