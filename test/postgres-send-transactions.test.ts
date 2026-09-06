import { expect, test } from "bun:test";
import { z } from "zod";

import { AgentClosedError, IdempotencyConflictError } from "../src/domain/errors.js";
import { AgentGeneration, SessionKey } from "../src/domain/lifecycle-values.js";
import type { SendMessageCommand, SendMessageResult } from "../src/domain/models.js";
import { IdempotencyKey, type Instant, MessageContent } from "../src/domain/value-objects.js";
import {
  refreshSendActors,
  SEND_SESSION,
  type SendSessionSnapshot,
  type SendTransactionFixture,
  sendCommand,
  senderActivity,
  sendPostgresConfigured,
  sendSessionSnapshot,
  sendUsageSnapshot,
  withSendTransactionFixture,
} from "./support/postgres-send-transactions.js";

function countStatement(statements: readonly string[], command: string): number {
  return statements.filter((statement: string): boolean => statement.trim() === command).length;
}

function expectSendTransaction(statements: readonly string[], expectedCount: number): void {
  expect(countStatement(statements, "begin")).toBe(2);
  expect(countStatement(statements, "commit")).toBe(2);
  expect(countStatement(statements, "rollback")).toBe(0);
  expect(statements).toHaveLength(expectedCount);
  expect(
    statements.filter((statement: string): boolean => statement.includes("set_config")),
  ).toHaveLength(2);
  expect(
    statements.filter((statement: string): boolean => statement.includes("AS candidates")),
  ).toHaveLength(1);
  expect(statements[1]).toContain("set_config");
  expect(statements[2]).toContain("AS candidates");
  expect(statements.slice(3, 5).map((statement: string): string => statement.trim())).toEqual([
    "commit",
    "begin",
  ]);
}

function sessionRow(
  rows: readonly SendSessionSnapshot[],
  session: SessionKey,
): SendSessionSnapshot {
  const row: SendSessionSnapshot | undefined = rows.find(
    (candidate: SendSessionSnapshot): boolean => candidate.session_key === session.value,
  );
  if (row === undefined) throw new Error("Missing expected sender session");
  return row;
}

test.skipIf(!sendPostgresConfigured)(
  "PostgreSQL named-session send and duplicate release their preflight lease without duplicate renewal",
  async (): Promise<void> => {
    await withSendTransactionFixture(async (fixture: SendTransactionFixture): Promise<void> => {
      fixture.clock.set(fixture.now.addMinutes(5));
      const command: SendMessageCommand = sendCommand(fixture);
      fixture.statements.length = 0;
      const sent: SendMessageResult = await fixture.store.sendMessage(command);
      expectSendTransaction(fixture.statements, 19);
      expect(sent.duplicate).toBe(false);
      expect(sent.message.senderId.value).toBe(fixture.sender.value);
      expect(sent.message.recipientId.value).toBe(fixture.recipient.value);
      expect(sent.message.senderGeneration.value).toBe(1);
      expect(sent.message.recipientGeneration.value).toBe(1);
      expect(sent.message.createdAt.toISOString()).toBe(fixture.clock.now().toISOString());
      const afterSend: SendSessionSnapshot[] = await sendSessionSnapshot(fixture);
      const named: SendSessionSnapshot = sessionRow(afterSend, SEND_SESSION);
      expect(named.renewed).toBe(fixture.clock.now().toISOString());
      expect(named.expires).toBe(fixture.clock.now().addMinutes(60).toISOString());
      expect(sessionRow(afterSend, SessionKey.default()).renewed).toBe(fixture.now.toISOString());
      const activity: string = await senderActivity(fixture);
      expect(activity).toBe(fixture.clock.now().toISOString());
      const expectedUsage: {
        readonly physical: number;
        readonly count: number;
        readonly bytes: number;
      } = {
        physical: 1,
        count: 1,
        bytes: Buffer.byteLength(sent.message.content.value, "utf8"),
      };
      expect(await sendUsageSnapshot(fixture)).toEqual(expectedUsage);

      fixture.clock.set(fixture.now.addMinutes(10));
      fixture.statements.length = 0;
      const duplicate: SendMessageResult = await fixture.store.sendMessage(command);
      expectSendTransaction(fixture.statements, 11);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.message.messageId.value).toBe(sent.message.messageId.value);
      expect(duplicate.message.sequence.value).toBe(sent.message.sequence.value);
      expect(duplicate.message.threadId.value).toBe(sent.message.threadId.value);
      expect(duplicate.message.createdAt.toISOString()).toBe(sent.message.createdAt.toISOString());
      expect(duplicate.message.content.value).toBe(sent.message.content.value);
      expect(
        fixture.statements.some(
          (statement: string): boolean =>
            statement.includes("INSERT INTO murmur.agent_sessions") ||
            statement.includes("INSERT INTO murmur.messages"),
        ),
      ).toBe(false);
      expect(await sendSessionSnapshot(fixture)).toEqual(afterSend);
      expect(await senderActivity(fixture)).toBe(activity);
      expect(await sendUsageSnapshot(fixture)).toEqual(expectedUsage);
    });
  },
  20_000,
);

type FailedSend = "idempotency" | "provenance" | "closed-recipient";
const FAILED_SENDS: readonly FailedSend[] = ["idempotency", "provenance", "closed-recipient"];

async function verifyExpiredSendFailure(
  fixture: SendTransactionFixture,
  failure: FailedSend,
): Promise<void> {
  const expired: SendMessageResult = await fixture.store.sendMessage(sendCommand(fixture));
  fixture.clock.set(fixture.now.addDays(29));
  await refreshSendActors(fixture);
  const retainedCommand: SendMessageCommand = {
    ...sendCommand(fixture),
    idempotencyKey: IdempotencyKey.parse("retained-conflict"),
  };
  const retained: SendMessageResult = await fixture.store.sendMessage(retainedCommand);
  fixture.clock.set(fixture.now.addDays(30));
  await refreshSendActors(fixture);
  if (failure === "closed-recipient") {
    await fixture.store.closeAgent({
      agentId: fixture.recipient,
      closeReason: "completed",
      expectedGeneration: AgentGeneration.parse(1),
    });
  }
  const sessions: SendSessionSnapshot[] = await sendSessionSnapshot(fixture);
  const activity: string = await senderActivity(fixture);
  expect((await sendUsageSnapshot(fixture)).physical).toBe(2);
  const attemptTime: Instant = fixture.now.addDays(30).addMinutes(5);
  fixture.clock.set(attemptTime);
  expect(expired.message.expiresAt.toEpochMilliseconds()).toBeLessThan(
    attemptTime.toEpochMilliseconds(),
  );
  fixture.statements.length = 0;
  let command: SendMessageCommand;
  if (failure === "idempotency") {
    command = { ...retainedCommand, content: MessageContent.parse("Different retry content") };
  } else if (failure === "provenance") {
    command = {
      ...sendCommand(fixture),
      idempotencyKey: IdempotencyKey.parse("invalid-provenance"),
      provenance: {
        messageKind: "orchestration_request",
        orchestratorPolicyId: null,
        senderAuthority: "peer",
      },
    };
  } else {
    command = {
      ...sendCommand(fixture),
      idempotencyKey: IdempotencyKey.parse("closed-recipient-send"),
    };
  }
  const operation: Promise<SendMessageResult> = fixture.store.sendMessage(command);
  if (failure === "idempotency")
    await expect(operation).rejects.toBeInstanceOf(IdempotencyConflictError);
  else if (failure === "provenance")
    await expect(operation).rejects.toThrow(
      "An orchestration request requires a policy identifier",
    );
  else await expect(operation).rejects.toBeInstanceOf(AgentClosedError);
  expect(countStatement(fixture.statements, "begin")).toBe(4);
  expect(countStatement(fixture.statements, "commit")).toBe(3);
  expect(countStatement(fixture.statements, "rollback")).toBe(1);
  expect(
    fixture.statements.filter((statement: string): boolean => statement.includes("AS candidates")),
  ).toHaveLength(1);
  expect(
    fixture.statements.filter((statement: string): boolean =>
      statement.includes("INSERT INTO murmur.agent_sessions"),
    ),
  ).toHaveLength(failure === "closed-recipient" ? 1 : 0);
  expect(await sendSessionSnapshot(fixture)).toEqual(sessions);
  expect(await senderActivity(fixture)).toBe(activity);
  expect(await sendUsageSnapshot(fixture)).toEqual({
    physical: 1,
    count: 1,
    bytes: Buffer.byteLength(retained.message.content.value, "utf8"),
  });
  const remaining: unknown = await fixture.admin`
    SELECT message_id::text AS message_id FROM murmur.messages
    WHERE tenant_id = ${fixture.tenant.value}::uuid ORDER BY tenant_sequence
  `;
  expect(z.array(z.strictObject({ message_id: z.string().uuid() })).parse(remaining)).toEqual([
    { message_id: retained.message.messageId.value },
  ]);
}

test.skipIf(!sendPostgresConfigured)(
  "PostgreSQL expiration and quota cleanup stay committed when subsequent sends fail without changing leases",
  async (): Promise<void> => {
    for (const failure of FAILED_SENDS) {
      await withSendTransactionFixture(async (fixture: SendTransactionFixture): Promise<void> => {
        await verifyExpiredSendFailure(fixture, failure);
      });
    }
  },
  30_000,
);
