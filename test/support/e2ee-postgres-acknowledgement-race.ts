import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { postgresSslOptions } from "../../src/postgres-tls.js";
import type {
  AcknowledgeEncryptedMessagesOutput,
  EncryptedMessageReadReceiptDto,
} from "../../src/e2ee/wire-tools.js";
import { type DeferredSignal, deferredSignal } from "./cloud-mcp-harness.js";
import { testTlsConfiguration } from "./hosted-mcp-harness.js";

const CountRowsSchema: z.ZodType<[{ readonly count: number }]> = z.tuple([
  z.strictObject({ count: z.coerce.number().int().nonnegative() }),
]);
const LockedRowSchema: z.ZodType<{ readonly message_id: string }> = z.strictObject({
  message_id: z.string().uuid(),
});
const ReceiptRowSchema: z.ZodType<EncryptedMessageReadReceiptDto> = z.strictObject({
  message_id: z.string().uuid(),
  read_at: z.iso.datetime(),
});

export type ConcurrentEncryptedAcknowledgements = {
  readonly first: AcknowledgeEncryptedMessagesOutput;
  readonly second: AcknowledgeEncryptedMessagesOutput;
  readonly stored: readonly EncryptedMessageReadReceiptDto[];
};

async function waitForBlockedUpdates(observer: Sql): Promise<void> {
  let attempt: number = 0;
  while (attempt < 500) {
    const raw: unknown = await observer`
      SELECT pg_catalog.count(*)::int AS count
      FROM pg_catalog.pg_stat_activity
      WHERE datname = pg_catalog.current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%UPDATE murmur.e2ee_messages%'
    `;
    if (CountRowsSchema.parse(raw)[0].count >= 2) return;
    attempt += 1;
  }
  throw new Error("Timed out waiting for concurrent encrypted acknowledgements");
}

export async function runConcurrentEncryptedAcknowledgements(options: {
  readonly adminDatabaseUrl: string;
  readonly first: () => Promise<AcknowledgeEncryptedMessagesOutput>;
  readonly messageIds: readonly string[];
  readonly second: () => Promise<AcknowledgeEncryptedMessagesOutput>;
  readonly tenantId: string;
}): Promise<ConcurrentEncryptedAcknowledgements> {
  const database: Sql = postgres(options.adminDatabaseUrl, {
    connect_timeout: 10,
    max: 2,
    ssl: postgresSslOptions(options.adminDatabaseUrl, testTlsConfiguration),
  });
  const held: DeferredSignal = deferredSignal();
  const release: DeferredSignal = deferredSignal();
  const lockHolder: Promise<unknown> = database.begin(
    async (transaction: TransactionSql): Promise<void> => {
      const raw: unknown = await transaction`
        SELECT message_id::text AS message_id
        FROM murmur.e2ee_messages
        WHERE tenant_id = ${options.tenantId}::uuid
          AND message_id = ANY(${database.array([...options.messageIds])}::uuid[])
        ORDER BY message_id ASC
        FOR UPDATE
      `;
      z.array(LockedRowSchema).length(options.messageIds.length).parse(raw);
      held.resolve();
      await release.promise;
    },
  );
  let firstPromise: Promise<AcknowledgeEncryptedMessagesOutput> | null = null;
  let secondPromise: Promise<AcknowledgeEncryptedMessagesOutput> | null = null;
  try {
    const prematureEnd: Promise<void> = lockHolder.then((): never => {
      throw new Error("Encrypted acknowledgement lock holder ended prematurely");
    });
    await Promise.race([held.promise, prematureEnd]);
    firstPromise = options.first();
    secondPromise = options.second();
    await waitForBlockedUpdates(database);
    release.resolve();
    const acknowledged: readonly [
      AcknowledgeEncryptedMessagesOutput,
      AcknowledgeEncryptedMessagesOutput,
    ] = await Promise.all([firstPromise, secondPromise]);
    const storedRaw: unknown = await database`
      SELECT message_id::text AS message_id,
        to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at
      FROM murmur.e2ee_messages
      WHERE tenant_id = ${options.tenantId}::uuid
        AND message_id = ANY(${database.array([...options.messageIds])}::uuid[])
      ORDER BY message_id ASC
    `;
    const stored: EncryptedMessageReadReceiptDto[] = z
      .array(ReceiptRowSchema)
      .length(options.messageIds.length)
      .parse(storedRaw);
    return { first: acknowledged[0], second: acknowledged[1], stored };
  } finally {
    release.resolve();
    const pending: Promise<unknown>[] = [lockHolder];
    if (firstPromise !== null) pending.push(firstPromise);
    if (secondPromise !== null) pending.push(secondPromise);
    await Promise.allSettled(pending);
    await Promise.allSettled([database.end({ timeout: 5 })]);
  }
}
