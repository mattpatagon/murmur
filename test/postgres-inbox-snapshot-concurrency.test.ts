import { expect, test } from "bun:test";

import type { GetMessagesQuery, Message, SendMessageResult } from "../src/domain/models.js";
import { IdempotencyKey, Sequence, ThreadId } from "../src/domain/value-objects.js";
import type { InboxReadResult, InboxSubscription } from "../src/storage/message-store.js";
import {
  type SnapshotFixture,
  snapshotPostgresConfigured,
  withSnapshotFixture,
} from "./support/postgres-inbox-snapshot-concurrency.js";
import { baseMessageCommand } from "./support/store-fixture.js";

type ReadOutcome =
  | { readonly ok: true; readonly result: InboxReadResult }
  | { readonly ok: false; readonly error: unknown };

function inboxQuery(fixture: SnapshotFixture): GetMessagesQuery {
  return {
    afterSequence: Sequence.zero(),
    agentId: fixture.reader,
    generation: null,
    limit: 10,
    sessionKey: null,
    threadId: null,
    unreadOnly: false,
  };
}

for (const empty of [false, true]) {
  test.skipIf(!snapshotPostgresConfigured)(
    `PostgreSQL ${empty ? "empty filtered" : "populated"} inbox snapshot cannot pair its page with a later committed high-water`,
    async (): Promise<void> => {
      await withSnapshotFixture(async (fixture: SnapshotFixture): Promise<void> => {
        const first: SendMessageResult = await fixture.deadline.wait(
          fixture.writer.sendMessage({
            ...baseMessageCommand(),
            senderId: fixture.sender,
            recipientId: fixture.reader,
            idempotencyKey: IdempotencyKey.parse("snapshot-before-read"),
          }),
        );
        const query: GetMessagesQuery = {
          ...inboxQuery(fixture),
          threadId: empty ? ThreadId.parse("snapshot-empty-filter") : null,
        };
        fixture.barrier.arm();
        let readerFinished: boolean = false;
        const pending: Promise<ReadOutcome> = fixture.store.getMessagesWithVersion(query).then(
          (result: InboxReadResult): ReadOutcome => {
            readerFinished = true;
            return { ok: true, result };
          },
          (error: unknown): ReadOutcome => {
            readerFinished = true;
            return { ok: false, error };
          },
        );
        let subscription: InboxSubscription | null = null;
        try {
          await fixture.barrier.reached(fixture.deadline);
          expect(readerFinished).toBe(false);
          const second: SendMessageResult = await fixture.deadline.wait(
            fixture.writer.sendMessage({
              ...baseMessageCommand(),
              senderId: fixture.sender,
              recipientId: fixture.reader,
              idempotencyKey: IdempotencyKey.parse("snapshot-during-read"),
            }),
          );
          expect(second.duplicate).toBe(false);
          expect(second.message.sequence.isAfter(first.message.sequence)).toBe(true);
          // sendMessage resolves after its actual COMMIT while the original read remains held.
          expect(readerFinished).toBe(false);
          fixture.barrier.release();
          const outcome: ReadOutcome = await fixture.deadline.wait(pending);
          if (!outcome.ok) throw outcome.error;
          const snapshot: InboxReadResult = outcome.result;
          expect(fixture.barrier.hits).toBe(1);
          expect(
            snapshot.messages.map((message: Message): string => message.messageId.value),
          ).toEqual(empty ? [] : [first.message.messageId.value]);
          const continuation: InboxReadResult = await fixture.deadline.wait(
            fixture.store.getMessagesWithVersion({
              ...inboxQuery(fixture),
              afterSequence: first.message.sequence,
            }),
          );
          expect(
            continuation.messages.map((message: Message): string => message.messageId.value),
          ).toEqual([second.message.messageId.value]);
          expect(continuation.inboxVersion.value).toBe(second.message.sequence.value);
          const hints: number[] = [];
          subscription = await fixture.deadline.wait(
            fixture.store.watchInbox(
              fixture.reader,
              snapshot.inboxVersion,
              async (sequence: Sequence): Promise<void> => {
                hints.push(sequence.value);
              },
            ),
          );
          // A missed live hint is recovered from durable state before watch initialization resolves.
          expect(snapshot.inboxVersion.value).toBe(first.message.sequence.value);
          expect(hints).toEqual([second.message.sequence.value]);
        } finally {
          fixture.barrier.release();
          try {
            await fixture.deadline.wait(pending);
          } finally {
            if (subscription !== null) await subscription.close();
          }
        }
      });
    },
    30_000,
  );
}
