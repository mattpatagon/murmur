import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import { POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED } from "../../src/storage/postgres-message-transactions.js";
import { testTlsConfiguration } from "./hosted-mcp-harness.js";

class DeferredSignal {
  public readonly promise: Promise<void>;
  private resolver: (() => void) | null;

  public constructor() {
    this.resolver = null;
    this.promise = new Promise<void>((resolve: () => void): void => {
      this.resolver = resolve;
    });
  }

  public resolve(): void {
    const resolver: (() => void) | null = this.resolver;
    if (resolver === null) throw new Error("Deferred signal was not initialized");
    resolver();
  }
}

const CountRowSchema: z.ZodType<{ readonly count: number }> = z.strictObject({
  count: z.number().int().nonnegative(),
});

async function waitForCount(
  query: () => Promise<unknown>,
  description: string,
  minimumCount: number = 1,
): Promise<void> {
  let attempt: number = 0;
  while (attempt < 500) {
    const rows: { readonly count: number }[] = z.array(CountRowSchema).parse(await query());
    const row: { readonly count: number } | undefined = rows[0];
    if (row !== undefined && row.count >= minimumCount) return;
    attempt += 1;
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function runConcurrentPolicyUpdates<T, U>(options: {
  readonly databaseUrl: string | undefined;
  readonly first: () => Promise<T>;
  readonly repositoryName: string;
  readonly scopeKind: "organization" | "personal";
  readonly scopeOwnerId: string;
  readonly second: () => Promise<U>;
  readonly tenantId: string;
}): Promise<readonly [T, U]> {
  const databaseUrl: string | undefined = options.databaseUrl;
  if (databaseUrl === undefined) return await Promise.all([options.first(), options.second()]);
  const database: Sql = postgres(databaseUrl, {
    connect_timeout: 10,
    max: 3,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const held: DeferredSignal = new DeferredSignal();
  const release: DeferredSignal = new DeferredSignal();
  const lockHolder: Promise<unknown> = database.begin(
    async (transaction: TransactionSql): Promise<void> => {
      await transaction`
        SELECT policy_id
        FROM murmur.orchestrator_policies
        WHERE tenant_id = ${options.tenantId}::uuid
          AND scope_kind = ${options.scopeKind}
          AND scope_owner_id = ${options.scopeOwnerId}::uuid
          AND repository_name = ${options.repositoryName}
        FOR UPDATE
      `;
      held.resolve();
      await release.promise;
    },
  );
  let firstPromise: Promise<T> | null = null;
  let secondPromise: Promise<U> | null = null;
  try {
    const holderEndedBeforeAcquisition: Promise<void> = lockHolder.then((): never => {
      throw new Error("Policy lock holder ended before acquiring the scope row lock");
    });
    await Promise.race([held.promise, holderEndedBeforeAcquisition]);
    firstPromise = options.first();
    secondPromise = options.second();
    await waitForCount(
      async (): Promise<unknown> =>
        await database`
          SELECT pg_catalog.count(*)::integer AS count
          FROM pg_catalog.pg_stat_activity
          WHERE datname = pg_catalog.current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%INSERT INTO murmur.orchestrator_policies%'
        `,
      "concurrent policy updates behind the scope row lock",
      2,
    );
    release.resolve();
    return await Promise.all([firstPromise, secondPromise]);
  } finally {
    release.resolve();
    const pending: Promise<unknown>[] = [lockHolder];
    if (firstPromise !== null) pending.push(firstPromise);
    if (secondPromise !== null) pending.push(secondPromise);
    await Promise.allSettled(pending);
    await Promise.allSettled([database.end({ timeout: 5 })]);
  }
}

export async function runSerializedAuthorityMutation<T, U>(options: {
  readonly ask: () => Promise<T>;
  readonly databaseUrl: string | undefined;
  readonly mutate: () => Promise<U>;
  readonly mutationQueryFragment: string;
  readonly recipientId: string;
  readonly tenantId: string;
}): Promise<readonly [T, U]> {
  const databaseUrl: string | undefined = options.databaseUrl;
  if (databaseUrl === undefined) return [await options.ask(), await options.mutate()];
  const database: Sql = postgres(databaseUrl, {
    connect_timeout: 10,
    max: 2,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const held: DeferredSignal = new DeferredSignal();
  const release: DeferredSignal = new DeferredSignal();
  const tenantRecipientId: string = `${options.tenantId}:${options.recipientId}`;
  const lockHolder: Promise<unknown> = database.begin(
    async (transaction: TransactionSql): Promise<void> => {
      await transaction`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            ${tenantRecipientId},
            ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
          )
        )
      `;
      held.resolve();
      await release.promise;
    },
  );
  let askPromise: Promise<T> | null = null;
  let mutationPromise: Promise<U> | null = null;
  try {
    await held.promise;
    askPromise = options.ask();
    await waitForCount(
      async (): Promise<unknown> =>
        await database`
          SELECT pg_catalog.count(*)::integer AS count
          FROM pg_catalog.pg_locks
          WHERE locktype = 'advisory'
            AND classid = (
              pg_catalog.hashtextextended(
                ${tenantRecipientId},
                ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
              ) >> 32 & 4294967295::bigint
            )::oid
            AND objid = (
              pg_catalog.hashtextextended(
                ${tenantRecipientId},
                ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
              ) & 4294967295::bigint
            )::oid
            AND objsubid = 1
            AND NOT granted
        `,
      "orchestration request admission lock",
    );
    mutationPromise = options.mutate();
    await waitForCount(
      async (): Promise<unknown> =>
        await database`
          SELECT pg_catalog.count(*)::integer AS count
          FROM pg_catalog.pg_stat_activity
          WHERE datname = pg_catalog.current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE ${`%${options.mutationQueryFragment}%`}
        `,
      "authority mutation row lock",
    );
    release.resolve();
    const result: [T, U] = await Promise.all([askPromise, mutationPromise]);
    return result;
  } finally {
    release.resolve();
    await lockHolder;
    const pending: Promise<unknown>[] = [];
    if (askPromise !== null) pending.push(askPromise);
    if (mutationPromise !== null) pending.push(mutationPromise);
    await Promise.allSettled(pending);
    await database.end({ timeout: 5 });
  }
}

export async function runConcurrentPeerRegistration(options: {
  readonly agentId: string;
  readonly attemptMint: () => Promise<string>;
  readonly databaseUrl: string;
  readonly tenantId: string;
}): Promise<string> {
  const database: Sql = postgres(options.databaseUrl, {
    connect_timeout: 10,
    max: 2,
    ssl: postgresSslOptions(options.databaseUrl, testTlsConfiguration),
  });
  const held: DeferredSignal = new DeferredSignal();
  const release: DeferredSignal = new DeferredSignal();
  const peerRegistration: Promise<unknown> = database.begin(
    async (transaction: TransactionSql): Promise<void> => {
      await transaction`
        INSERT INTO murmur.agents(
          tenant_id, agent_id, authority, display_name, metadata, created_at, last_seen_at
        ) VALUES (
          ${options.tenantId}::uuid,
          ${options.agentId},
          'peer',
          'Concurrent peer registration',
          '{}'::jsonb,
          pg_catalog.statement_timestamp(),
          pg_catalog.statement_timestamp()
        )
      `;
      held.resolve();
      await release.promise;
    },
  );
  let mintPromise: Promise<string> | null = null;
  try {
    await held.promise;
    mintPromise = options.attemptMint();
    await waitForCount(
      async (): Promise<unknown> =>
        await database`
          SELECT pg_catalog.count(*)::integer AS count
          FROM pg_catalog.pg_stat_activity
          WHERE datname = pg_catalog.current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%INSERT INTO murmur.agents%'
        `,
      "orchestrator reservation behind peer registration",
    );
    release.resolve();
    return await mintPromise;
  } finally {
    release.resolve();
    await peerRegistration;
    if (mintPromise !== null) await Promise.allSettled([mintPromise]);
    await database`
      DELETE FROM murmur.agents
      WHERE tenant_id = ${options.tenantId}::uuid
        AND agent_id = ${options.agentId}
    `;
    await database.end({ timeout: 5 });
  }
}
