import { expect } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { SessionKey } from "../../src/domain/lifecycle-values.js";
import type { SendMessageCommand } from "../../src/domain/models.js";
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
import { baseMessageCommand, MutableClock } from "./store-fixture.js";

export const SEND_SESSION: SessionKey = SessionKey.parse("send-pane");
export const sendPostgresConfigured: boolean =
  databaseUrl !== undefined && adminDatabaseUrl !== undefined;
export type SendTransactionFixture = {
  readonly admin: Sql;
  readonly clock: MutableClock;
  readonly now: Instant;
  readonly recipient: AgentId;
  readonly sender: AgentId;
  readonly statements: string[];
  readonly store: PostgresMessageStore;
  readonly tenant: TenantId;
};

const RoleRowsSchema: z.ZodType<
  readonly [{ readonly name: "murmur_app"; readonly superuser: false; readonly bypass: false }]
> = z.tuple([
  z.strictObject({
    name: z.literal("murmur_app"),
    superuser: z.literal(false),
    bypass: z.literal(false),
  }),
]);

export async function refreshSendActors(fixture: SendTransactionFixture): Promise<void> {
  for (const agentId of [fixture.sender, fixture.recipient]) {
    await fixture.store.registerAgent({
      agentId,
      displayName: DisplayName.parse("Send actor"),
      metadata: {},
    });
  }
  await fixture.store.registerAgent({
    agentId: fixture.sender,
    displayName: DisplayName.parse("Send actor"),
    metadata: {},
    sessionKey: SEND_SESSION,
  });
}

export function sendCommand(fixture: SendTransactionFixture): SendMessageCommand {
  return {
    ...baseMessageCommand(),
    senderId: fixture.sender,
    recipientId: fixture.recipient,
    sessionKey: SEND_SESSION,
  };
}

export async function withSendTransactionFixture(
  run: (fixture: SendTransactionFixture) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("PostgreSQL URLs are required");
  const tenant: TenantId = TenantId.generate();
  const now: Instant = new SystemClock().now();
  const clock: MutableClock = new MutableClock(now);
  const statements: string[] = [];
  const admin: Sql = postgres(adminDatabaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    ...POSTGRES_RUNTIME_POOL,
    max: 1,
    debug: (_connection: number, statement: string): void => {
      statements.push(statement);
    },
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const candidate: unknown = Reflect.construct(PostgresMessageStore, [
    app,
    clock,
    tenant,
    {
      closed: false,
      closePromise: null,
      dispatcher: new PostgresInboxDispatcher({
        readVersion: async (): Promise<Sequence> => Sequence.zero(),
        reportError: (): void => {},
      }),
      listener: null,
    },
    true,
  ]);
  if (!(candidate instanceof PostgresMessageStore))
    throw new Error("Invalid PostgreSQL send fixture");
  const store: PostgresMessageStore = candidate;
  try {
    const role: unknown = await app`
      SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_catalog.pg_roles WHERE rolname = current_user
    `;
    RoleRowsSchema.parse(role);
    await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
      VALUES (${tenant.value}::uuid, ${`send-transactions-${tenant.value}`}, 'Send transaction fixture')`;
    const fixture: SendTransactionFixture = {
      admin,
      clock,
      now,
      tenant,
      store,
      statements,
      sender: AgentId.parse(`send:${tenant.value}`),
      recipient: AgentId.parse(`receive:${tenant.value}`),
    };
    await refreshSendActors(fixture);
    await run(fixture);
  } finally {
    try {
      await store.close();
    } finally {
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
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }
}

export type SendSessionSnapshot = {
  readonly session_key: string;
  readonly generation: number;
  readonly started: string;
  readonly renewed: string;
  readonly expires: string;
  readonly ended: string | null;
  readonly end_reason: string | null;
};
const SessionsSchema: z.ZodType<SendSessionSnapshot[]> = z
  .array(
    z.strictObject({
      session_key: z.string().min(1).max(64),
      generation: z.number().int().positive().safe(),
      started: z.iso.datetime({ precision: 3 }),
      renewed: z.iso.datetime({ precision: 3 }),
      expires: z.iso.datetime({ precision: 3 }),
      ended: z.iso.datetime({ precision: 3 }).nullable(),
      end_reason: z.enum(["stop", "session_end", "superseded", "expired", "closed"]).nullable(),
    }),
  )
  .max(10);

export async function sendSessionSnapshot(
  fixture: SendTransactionFixture,
): Promise<SendSessionSnapshot[]> {
  const raw: unknown = await fixture.admin`
    SELECT session_key, generation,
      to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started,
      to_char(last_renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS renewed,
      to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires,
      CASE WHEN ended_at IS NULL THEN NULL ELSE to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS ended,
      end_reason
    FROM murmur.agent_sessions WHERE tenant_id = ${fixture.tenant.value}::uuid
      AND agent_id = ${fixture.sender.value} ORDER BY generation, session_key
  `;
  return SessionsSchema.parse(raw);
}

export async function senderActivity(fixture: SendTransactionFixture): Promise<string> {
  const raw: unknown = await fixture.admin`
    SELECT to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value
    FROM murmur.agents WHERE tenant_id = ${fixture.tenant.value}::uuid AND agent_id = ${fixture.sender.value}
  `;
  return z.tuple([z.strictObject({ value: z.iso.datetime({ precision: 3 }) })]).parse(raw)[0].value;
}

export type SendUsageSnapshot = {
  readonly physical: number;
  readonly count: number;
  readonly bytes: number;
};
const UsageRowsSchema: z.ZodType<readonly [SendUsageSnapshot]> = z.tuple([
  z.strictObject({
    physical: z.number().int().nonnegative().safe(),
    count: z.number().int().nonnegative().safe(),
    bytes: z.coerce.number().int().nonnegative().safe(),
  }),
]);

export async function sendUsageSnapshot(
  fixture: SendTransactionFixture,
): Promise<SendUsageSnapshot> {
  const raw: unknown = await fixture.admin`
    SELECT (SELECT COUNT(*)::int FROM murmur.messages WHERE tenant_id = ${fixture.tenant.value}::uuid) AS physical,
      message_count::int AS count, message_content_bytes::text AS bytes
    FROM murmur.tenant_resource_usage WHERE tenant_id = ${fixture.tenant.value}::uuid
  `;
  return UsageRowsSchema.parse(raw)[0];
}
