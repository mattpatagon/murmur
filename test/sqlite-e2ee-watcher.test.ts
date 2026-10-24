import { expect, type Mock, spyOn, test } from "bun:test";

import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  encryptCanaryE2eeMessage,
} from "../scripts/lib/e2ee-canary-crypto.js";
import { AgentId, DisplayName, Instant, TenantId } from "../src/domain/value-objects.js";
import type { PutEncryptedMessageOutput } from "../src/e2ee/wire-tools.js";
import { StructuredLogger } from "../src/observability/structured-logger.js";
import type { EncryptedInboxUpdateHandler } from "../src/storage/e2ee-message-store.js";
import type { InboxSubscription } from "../src/storage/message-store.js";
import { SqliteE2eeMessageStore } from "../src/storage/sqlite-e2ee-message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";
import { MutableClock } from "./support/store-fixture.js";

const NOW: Instant = Instant.parse("2026-10-01T12:00:00.000Z");
type Signal = { readonly promise: Promise<void>; readonly resolve: () => void };
type Fixture = {
  readonly encrypted: SqliteE2eeMessageStore;
  readonly put: (counter: number) => Promise<PutEncryptedMessageOutput>;
};
type ControlledInterval = {
  readonly cleared: Mock<typeof clearInterval>;
  readonly installed: Mock<typeof setInterval>;
  readonly handle: ReturnType<typeof setInterval>;
  readonly tick: () => void;
  readonly restore: () => void;
};

function controlledInterval(): ControlledInterval {
  const handle: ReturnType<typeof setInterval> = setInterval((): void => {}, 60_000);
  clearInterval(handle);
  const installed: Mock<typeof setInterval> = spyOn(globalThis, "setInterval");
  const cleared: Mock<typeof clearInterval> = spyOn(globalThis, "clearInterval");
  installed.mockReturnValue(handle);
  return {
    handle,
    installed,
    cleared,
    tick: (): void => {
      const call: Parameters<typeof setInterval> | undefined = installed.mock.calls[0];
      if (call === undefined) throw new Error("Watcher interval was not installed");
      expect(call[1]).toBe(200);
      const handler: unknown = call[0];
      if (typeof handler !== "function") throw new Error("Expected an interval callback");
      handler();
    },
    restore: (): void => {
      installed.mockRestore();
      cleared.mockRestore();
    },
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const clock: MutableClock = new MutableClock(NOW);
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", clock);
  try {
    for (const agentId of ["alice", "bob"])
      store.registerAgent({
        agentId: AgentId.parse(agentId),
        displayName: DisplayName.parse(agentId),
        metadata: {},
      });
    const encrypted: unknown = store.scopeE2ee(TenantId.founding());
    if (!(encrypted instanceof SqliteE2eeMessageStore)) throw new Error("Missing encrypted store");
    const alice: CanaryE2eeIdentity = await createCanaryE2eeIdentity(
      "alice",
      new Date(NOW.toISOString()),
    );
    const bob: CanaryE2eeIdentity = await createCanaryE2eeIdentity(
      "bob",
      new Date(NOW.toISOString()),
    );
    await encrypted.publishAgentKeyBundle({ agent_id: "alice", bundle: canaryE2eeBundle(alice) });
    await encrypted.publishAgentKeyBundle({ agent_id: "bob", bundle: canaryE2eeBundle(bob) });
    await run({
      encrypted,
      put: async (counter: number): Promise<PutEncryptedMessageOutput> =>
        await encrypted.putEncryptedMessage(
          await encryptCanaryE2eeMessage({
            branch: "watcher-test",
            claim: encrypted.claimEncryptionPrekey({
              context: {
                branch: "watcher-test",
                client: "codex",
                repository: "mattpatagon/murmur",
              },
              recipient_id: "bob",
              sender_id: "alice",
            }),
            idempotencyKey: `watcher-${counter}`,
            now: new Date(NOW.toISOString()),
            pairCounter: counter,
            plaintext: "Encrypted watcher delivery",
            recipient: bob,
            repository: "mattpatagon/murmur",
            sender: alice,
            senderId: "alice",
            tenantId: TenantId.founding().value,
          }),
        ),
    });
  } finally {
    store.close();
  }
}

async function withWatcher(
  fixture: Fixture,
  handler: EncryptedInboxUpdateHandler,
  run: (watcher: InboxSubscription, timer: ControlledInterval) => Promise<void>,
): Promise<void> {
  const timer: ControlledInterval = controlledInterval();
  let watcher: InboxSubscription | null = null;
  try {
    watcher = fixture.encrypted.watchEncryptedInbox("bob", 0, handler);
    await run(watcher, timer);
  } finally {
    try {
      if (watcher !== null) await watcher.close();
    } finally {
      timer.restore();
    }
  }
}

test("encrypted SQLite watcher catches up immediately, serializes callbacks, and closes once", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    await fixture.put(1);
    const released: Signal = Promise.withResolvers<void>();
    const delivered: number[] = [];
    const summaries: Mock<SqliteE2eeMessageStore["getEncryptedInboxSummary"]> = spyOn(
      fixture.encrypted,
      // biome-ignore lint/security/noSecrets: This is a public method name, not credential material.
      "getEncryptedInboxSummary",
    );
    try {
      await withWatcher(
        fixture,
        (sequence: number): Promise<void> => {
          delivered.push(sequence);
          return sequence === 1 ? released.promise : Promise.resolve();
        },
        async (watcher: InboxSubscription, timer: ControlledInterval): Promise<void> => {
          expect(delivered).toEqual([1]);
          timer.tick();
          expect(summaries).toHaveBeenCalledTimes(1);
          await fixture.put(2);
          timer.tick();
          expect(delivered).toEqual([1]);
          expect(summaries).toHaveBeenCalledTimes(1);
          released.resolve();
          await released.promise;
          timer.tick();
          await Promise.resolve();
          expect(delivered).toEqual([1, 2]);
          timer.tick();
          expect(delivered).toEqual([1, 2]);
          expect(summaries).toHaveBeenCalledTimes(3);
          await watcher.close();
          await watcher.close();
          timer.tick();
          expect(summaries).toHaveBeenCalledTimes(3);
          expect(timer.installed).toHaveBeenCalledTimes(1);
          expect(timer.cleared).toHaveBeenCalledTimes(1);
          expect(timer.cleared).toHaveBeenCalledWith(timer.handle);
        },
      );
    } finally {
      released.resolve();
      summaries.mockRestore();
    }
  });
});

test("encrypted SQLite watcher retries lookup and handler failures without advancing its cursor", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    await fixture.put(1);
    const summaries: Mock<SqliteE2eeMessageStore["getEncryptedInboxSummary"]> = spyOn(
      fixture.encrypted,
      // biome-ignore lint/security/noSecrets: This is a public method name, not credential material.
      "getEncryptedInboxSummary",
    ).mockImplementationOnce((): never => {
      throw new Error("Private lookup detail");
    });
    const errors: Mock<StructuredLogger["error"]> = spyOn(
      StructuredLogger.prototype,
      "error",
    ).mockImplementation((): void => {});
    const delivered: number[] = [];
    let attempts: number = 0;
    try {
      await withWatcher(
        fixture,
        (sequence: number): Promise<void> => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("Private handler detail"));
          delivered.push(sequence);
          return Promise.resolve();
        },
        async (_watcher: InboxSubscription, timer: ControlledInterval): Promise<void> => {
          expect(errors).toHaveBeenCalledTimes(1);
          expect(attempts).toBe(0);
          timer.tick();
          await Promise.resolve();
          expect(errors).toHaveBeenCalledTimes(2);
          expect(delivered).toEqual([]);
          timer.tick();
          await Promise.resolve();
          timer.tick();
          expect(delivered).toEqual([1]);
          expect(attempts).toBe(2);
          expect(errors).toHaveBeenNthCalledWith(1, "operation.failed", {
            context: "Murmur SQLite encrypted inbox watcher error",
            error_class: "Error",
          });
          expect(errors).toHaveBeenNthCalledWith(2, "operation.failed", {
            context: "Murmur SQLite encrypted inbox watcher error",
            error_class: "Error",
          });
        },
      );
    } finally {
      summaries.mockRestore();
      errors.mockRestore();
    }
  });
});
