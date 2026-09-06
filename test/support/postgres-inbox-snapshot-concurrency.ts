import { expect } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import {
  AgentId,
  DisplayName,
  type Instant,
  Sequence,
  SystemClock,
  TenantId,
} from "../../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_POOL } from "../../src/postgres-runtime.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import { PostgresInboxDispatcher } from "../../src/storage/postgres-inbox-dispatcher.js";
import { PostgresMessageStore } from "../../src/storage/postgres-message-store.js";
import { adminDatabaseUrl, databaseUrl, testTlsConfiguration } from "./hosted-mcp-harness.js";
import { MutableClock } from "./store-fixture.js";

export const snapshotPostgresConfigured: boolean =
  databaseUrl !== undefined && adminDatabaseUrl !== undefined;

export class SnapshotDeadline {
  private readonly expires: number = performance.now() + 20_000;

  public async wait<Result>(operation: PromiseLike<Result>): Promise<Result> {
    const remaining: number = this.expires - performance.now();
    if (remaining <= 0) throw new Error("Inbox snapshot fixture deadline reached");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>(
          (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
            timer = setTimeout(
              (): void => reject(new Error("Inbox snapshot fixture deadline reached")),
              remaining,
            );
          },
        ),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export class SnapshotBarrier {
  private armed: boolean = false;
  private readonly entered: ReturnType<typeof Promise.withResolvers<void>> =
    Promise.withResolvers<void>();
  private readonly released: ReturnType<typeof Promise.withResolvers<void>> =
    Promise.withResolvers<void>();
  public hits: number = 0;

  public arm(): void {
    if (this.armed || this.hits !== 0) throw new Error("Inbox snapshot barrier is one-shot");
    this.armed = true;
  }

  public async reached(deadline: SnapshotDeadline): Promise<void> {
    await deadline.wait(this.entered.promise);
  }

  public release(): void {
    this.armed = false;
    this.released.resolve();
  }

  public transaction(transaction: TransactionSql): TransactionSql {
    return new Proxy(transaction, {
      apply: (target: TransactionSql, receiver: unknown, arguments_: unknown[]): unknown => {
        const result: unknown = Reflect.apply(target, receiver, arguments_);
        const template: ReturnType<z.ZodArray<z.ZodString>["safeParse"]> = z
          .array(z.string())
          .safeParse(arguments_[0]);
        if (
          !this.armed ||
          !template.success ||
          !template.data.join("?").includes("WITH candidates AS MATERIALIZED")
        )
          return result;
        this.armed = false;
        this.hits += 1;
        return this.afterPage(transaction, result);
      },
    });
  }

  private async afterPage(transaction: TransactionSql, pending: unknown): Promise<unknown> {
    // The real statement has completed. Hold only delivery of its unchanged rows to the adapter.
    const rows: unknown = await pending;
    const isolation: unknown =
      await transaction`SELECT current_setting('transaction_isolation') AS isolation`;
    z.tuple([z.strictObject({ isolation: z.literal("read committed") })]).parse(isolation);
    this.entered.resolve();
    await new SnapshotDeadline().wait(this.released.promise);
    return rows;
  }
}

function interceptedDatabase(database: Sql, barrier: SnapshotBarrier): Sql {
  const begin: Sql["begin"] = new Proxy(database.begin, {
    apply: (target: Sql["begin"], _receiver: unknown, arguments_: unknown[]): unknown => {
      const operation: unknown = arguments_[0];
      if (arguments_.length !== 1 || typeof operation !== "function")
        throw new Error("Unexpected snapshot fixture transaction signature");
      return target(async (transaction: TransactionSql): Promise<unknown> => {
        const result: unknown = Reflect.apply(operation, undefined, [
          barrier.transaction(transaction),
        ]);
        return await result;
      });
    },
  });
  return new Proxy(database, {
    get: (target: Sql, property: string | symbol, receiver: unknown): unknown =>
      property === "begin" ? begin : Reflect.get(target, property, receiver),
  });
}

function fixtureStore(database: Sql, clock: MutableClock, tenant: TenantId): PostgresMessageStore {
  const candidate: unknown = Reflect.construct(PostgresMessageStore, [
    database,
    clock,
    tenant,
    {
      closed: false,
      closePromise: null,
      dispatcher: new PostgresInboxDispatcher({
        readVersion: async (): Promise<Sequence> => Sequence.zero(),
        reportError: (): void => {},
      }),
      // No LISTEN connection: watch initialization must recover the durable committed version.
      listener: null,
    },
    true,
  ]);
  if (!(candidate instanceof PostgresMessageStore))
    throw new Error("Invalid inbox snapshot fixture");
  return candidate;
}

async function runtimePid(database: Sql): Promise<number> {
  const rows: unknown = await database`
    SELECT pg_backend_pid() AS pid, current_user AS role, rolsuper AS superuser,
      rolbypassrls AS bypass, current_setting('transaction_isolation') AS isolation
    FROM pg_catalog.pg_roles WHERE rolname = current_user
  `;
  const parsed: readonly [
    {
      readonly pid: number;
      readonly role: "murmur_app";
      readonly superuser: false;
      readonly bypass: false;
      readonly isolation: "read committed";
    },
  ] = z
    .tuple([
      z.strictObject({
        pid: z.number().int().positive(),
        role: z.literal("murmur_app"),
        superuser: z.literal(false),
        bypass: z.literal(false),
        isolation: z.literal("read committed"),
      }),
    ])
    .parse(rows);
  return parsed[0].pid;
}

export type SnapshotFixture = {
  readonly barrier: SnapshotBarrier;
  readonly deadline: SnapshotDeadline;
  readonly reader: AgentId;
  readonly sender: AgentId;
  readonly store: PostgresMessageStore;
  readonly writer: PostgresMessageStore;
};

export async function withSnapshotFixture(
  run: (fixture: SnapshotFixture) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("PostgreSQL URLs are required");
  const tenant: TenantId = TenantId.generate();
  const now: Instant = new SystemClock().now();
  const clock: MutableClock = new MutableClock(now);
  const deadline: SnapshotDeadline = new SnapshotDeadline();
  const barrier: SnapshotBarrier = new SnapshotBarrier();
  const admin: Sql = postgres(adminDatabaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const writing: Sql = postgres(databaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const store: PostgresMessageStore = fixtureStore(
    interceptedDatabase(app, barrier),
    clock,
    tenant,
  );
  const writer: PostgresMessageStore = fixtureStore(writing, clock, tenant);
  const reader: AgentId = AgentId.parse(`snapshot-reader:${tenant.value}`);
  const sender: AgentId = AgentId.parse(`snapshot-sender:${tenant.value}`);
  try {
    expect(await deadline.wait(runtimePid(app))).not.toBe(await deadline.wait(runtimePid(writing)));
    await deadline.wait(admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
      VALUES (${tenant.value}::uuid, ${`inbox-snapshot-${tenant.value}`}, 'Inbox snapshot fixture')`);
    for (const agentId of [reader, sender]) {
      await deadline.wait(
        writer.registerAgent({
          agentId,
          displayName: DisplayName.parse("Snapshot actor"),
          metadata: {},
        }),
      );
    }
    await run({ barrier, deadline, reader, sender, store, writer });
  } finally {
    barrier.release();
    const closed: PromiseSettledResult<void>[] = await Promise.allSettled([
      store.close(),
      writer.close(),
    ]);
    try {
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`DELETE FROM murmur.messages WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${tenant.value}::uuid`;
      });
      expect(
        z
          .array(z.strictObject({ tenant_id: z.string().uuid() }))
          .parse(
            await admin`SELECT tenant_id::text AS tenant_id FROM murmur.tenants WHERE tenant_id = ${tenant.value}::uuid`,
          ),
      ).toEqual([]);
      expect(
        closed.every(
          (result: PromiseSettledResult<void>): boolean => result.status === "fulfilled",
        ),
      ).toBe(true);
    } finally {
      await admin.end({ timeout: 1 });
    }
  }
}
