import { encryptCanaryE2eeMessage } from "../../scripts/lib/e2ee-canary-crypto.js";
import type { GetMessagesQuery } from "../../src/domain/models.js";
import { AgentId, DisplayName, MessageContent, Sequence } from "../../src/domain/value-objects.js";
import type { PutEncryptedMessageInput } from "../../src/e2ee/wire-tools.js";
import type { E2eeMessageStore } from "../../src/storage/e2ee-message-store.js";
import type { MessageStore } from "../../src/storage/message-store.js";
import {
  createTestE2eeIdentity,
  type TestE2eeIdentity,
  testE2eeBundle,
} from "./e2ee-hosted-crypto.js";
import { baseMessageCommand } from "./store-fixture.js";

export const PAGE_TEST_NOW: string = "2030-01-01T00:00:00.000Z";
export const PAGE_ERROR: string =
  "Inbox page exceeds the response byte budget. Retry get_messages or get_encrypted_messages with a smaller limit (start with 1); inbox resource reads must use these tools instead.";

export function pageQuery(limit: number): GetMessagesQuery {
  return {
    afterSequence: Sequence.zero(),
    agentId: AgentId.parse("bob"),
    generation: null,
    limit,
    sessionKey: null,
    threadId: null,
    unreadOnly: false,
  };
}

export async function registerPageAgents(store: MessageStore): Promise<void> {
  for (const agentId of ["alice", "bob", "charlie"]) {
    await store.registerAgent({
      agentId: AgentId.parse(agentId),
      displayName: DisplayName.parse(agentId),
      metadata: {},
    });
  }
}

export async function seedPlaintextPage(
  store: MessageStore,
  contents: readonly string[],
): Promise<void> {
  for (const content of contents) {
    await store.sendMessage({
      ...baseMessageCommand(),
      content: MessageContent.parse(content),
      idempotencyKey: null,
    });
  }
}

export async function seedEncryptedPage(
  store: E2eeMessageStore,
  tenantId: string,
  count: number,
  now: Date,
  beforeMessages?: (() => Promise<void>) | undefined,
): Promise<void> {
  const sender: TestE2eeIdentity = await createTestE2eeIdentity("alice", now);
  const recipient: TestE2eeIdentity = await createTestE2eeIdentity("bob", now);
  await store.publishAgentKeyBundle({ agent_id: "alice", bundle: testE2eeBundle(sender) });
  await store.publishAgentKeyBundle({ agent_id: "bob", bundle: testE2eeBundle(recipient) });
  if (beforeMessages !== undefined) await beforeMessages();
  for (let index: number = 0; index < count; index += 1) {
    const claim: Awaited<ReturnType<E2eeMessageStore["claimEncryptionPrekey"]>> =
      await store.claimEncryptionPrekey({
        context: { branch: "main", client: "codex", repository: "test/response-budget" },
        recipient_id: "bob",
        sender_id: "alice",
      });
    const input: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
      branch: "main",
      claim,
      idempotencyKey: `page-message-${index}`,
      now,
      pairCounter: index + 1,
      plaintext: "漢".repeat(100_000),
      recipient,
      repository: "test/response-budget",
      sender,
      senderId: "alice",
      tenantId,
    });
    await store.putEncryptedMessage(input);
  }
}
