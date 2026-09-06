import { expect, test } from "bun:test";

import { Instant, TenantId } from "../src/domain/value-objects.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import { MAX_INBOX_PAGE_BYTES } from "../src/storage/inbox-page-budget.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import {
  PAGE_ERROR,
  PAGE_TEST_NOW,
  pageQuery,
  registerPageAgents,
  seedEncryptedPage,
  seedPlaintextPage,
} from "./support/inbox-page-fixture.js";
import { MutableClock } from "./support/store-fixture.js";

test("SQLite rejects an oversized plaintext page rather than materializing or truncating it", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(
    ":memory:",
    new MutableClock(Instant.parse(PAGE_TEST_NOW)),
  );
  try {
    await registerPageAgents(store);
    await seedPlaintextPage(
      store,
      Array.from({ length: 7 }, (): string => "\u0001".repeat(100_000)),
    );
    expect((): void => {
      store.getMessages(pageQuery(500));
    }).toThrow(PAGE_ERROR);
    expect(store.getMessages(pageQuery(1))).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("a maximum-length three-byte Unicode plaintext message remains readable", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(
    ":memory:",
    new MutableClock(Instant.parse(PAGE_TEST_NOW)),
  );
  try {
    await registerPageAgents(store);
    await seedPlaintextPage(store, ["漢".repeat(100_000)]);
    expect(store.getMessages(pageQuery(500))).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("SQLite rejects an oversized encrypted page while retaining readable single messages", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(
    ":memory:",
    new MutableClock(Instant.parse(PAGE_TEST_NOW)),
  );
  try {
    await registerPageAgents(store);
    const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
    await seedEncryptedPage(encrypted, TenantId.founding().value, 4, new Date(PAGE_TEST_NOW));
    const input: {
      readonly after_sequence: number;
      readonly agent_id: string;
      readonly limit: number;
      readonly unread_only: boolean;
    } = { after_sequence: 0, agent_id: "bob", limit: 500, unread_only: false };
    expect((): void => {
      encrypted.getEncryptedMessages(input);
    }).toThrow(PAGE_ERROR);
    const page: Awaited<ReturnType<E2eeMessageStore["getEncryptedMessages"]>> =
      await encrypted.getEncryptedMessages({ ...input, limit: 1 });
    expect(page.messages).toHaveLength(1);
    const message: (typeof page.messages)[number] | undefined = page.messages[0];
    if (message === undefined) throw new Error("Encrypted page is missing");
    expect(message.envelope.ciphertext.length).toBe(699_072);
    const estimatedBytes: number =
      3 *
        (Buffer.byteLength(JSON.stringify(message.envelope)) +
          Buffer.byteLength(JSON.stringify(message.sender_chain))) +
      16_384;
    expect(estimatedBytes).toBeLessThan(MAX_INBOX_PAGE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(toolResult(page)))).toBeLessThanOrEqual(estimatedBytes);
  } finally {
    store.close();
  }
});
