import { expect, test } from "bun:test";

import { SessionKey } from "../src/domain/lifecycle-values.js";
import { AgentId, DisplayName, Instant, TenantId } from "../src/domain/value-objects.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

test("encrypted inbox reads renew existing sessions without creating or reviving leases", async (): Promise<void> => {
  const clock: MutableClock = new MutableClock(Instant.parse("2026-08-10T00:00:00.000Z"));
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", clock);
  const agentId: AgentId = AgentId.parse("bob");
  try {
    store.registerAgent({
      agentId,
      displayName: DisplayName.parse("Bob"),
      metadata: {},
      sessionKey: SessionKey.parse("encrypted-inbox-pane"),
    });
    const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
    clock.set(Instant.parse("2026-08-10T00:30:00.000Z"));
    await encrypted.getEncryptedInboxSummary({
      agent_id: "bob",
      session_key: "encrypted-inbox-pane",
    });
    clock.set(Instant.parse("2026-08-10T01:00:00.000Z"));
    expect(store.getAgent(agentId)).toMatchObject({ state: "active", liveSessionCount: 1 });
    await encrypted.getEncryptedInboxSummary({
      agent_id: "bob",
      session_key: "unregistered-observer",
    });
    clock.set(Instant.parse("2026-08-10T01:30:00.000Z"));
    await encrypted.getEncryptedInboxSummary({
      agent_id: "bob",
      session_key: "encrypted-inbox-pane",
    });
    expect(store.getAgent(agentId)).toMatchObject({ state: "inactive", liveSessionCount: 0 });
  } finally {
    store.close();
  }
});
