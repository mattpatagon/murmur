import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";

import {
  AGENT_DORMANCY_DAYS,
  AGENT_GC_DAYS,
  NOTICE_AUDIT_DAYS,
} from "../src/domain/lifecycle-values.js";
import type { SendMessageResult } from "../src/domain/models.js";
import { Instant, TenantId } from "../src/domain/value-objects.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { prunePostgresE2ee } from "../src/storage/postgres-e2ee-prune.js";
import {
  postgresHasPruneCandidates,
  type PostgresExpiryQuery,
  queryPostgresE2eePruneCandidates,
  queryPostgresPruneCandidates,
} from "../src/storage/postgres-expiry-preflight.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { setPostgresTenantContext } from "../src/storage/postgres-message-transactions.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";
import { baseMessageCommand, MutableClock } from "./support/store-fixture.js";

const NOW: Instant = Instant.parse("2026-08-04T12:00:00.000Z");
const BEFORE: Instant = Instant.parse("2026-08-04T11:59:59.999Z");
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;
type Probe = (query: PostgresExpiryQuery, tenantId: TenantId, now: Instant) => Promise<boolean>;
const probes: readonly Probe[] = [queryPostgresPruneCandidates, queryPostgresE2eePruneCandidates];

for (const probe of probes) {
  test(`${probe.name} issues one parameterized query and validates exactly one boolean row`, async (): Promise<void> => {
    const tenantId: TenantId = TenantId.generate();
    let calls: number = 0;
    let result: unknown = [{ candidates: false }];
    const query: PostgresExpiryQuery = (
      strings: TemplateStringsArray,
      ...values: readonly string[]
    ): Promise<unknown> => {
      calls += 1;
      expect(strings.join("?")).not.toContain(tenantId.value);
      expect(values).toContain(tenantId.value);
      expect(values).toContain(NOW.toISOString());
      return Promise.resolve(result);
    };
    expect(await probe(query, tenantId, NOW)).toBe(false);
    expect(calls).toBe(1);
    result = [{ candidates: true }];
    expect(await probe(query, tenantId, NOW)).toBe(true);
    expect(calls).toBe(2);
    for (const malformed of [
      [],
      [{ candidates: "false" }],
      [{ candidates: false }, { candidates: false }],
      [{ candidates: false, extra: true }],
    ]) {
      result = malformed;
      await expect(probe(query, tenantId, NOW)).rejects.toThrow();
    }
  });
}

type Fixture = {
  readonly admin: Sql;
  readonly app: Sql;
  readonly clock: MutableClock;
  readonly other: TenantId;
  readonly statements: string[];
  readonly store: MessageStore;
  readonly tenant: TenantId;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("Hosted PostgreSQL URLs are required");
  const tenant: TenantId = TenantId.generate();
  const other: TenantId = TenantId.generate();
  const statements: string[] = [];
  const admin: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    debug: (_connection: number, query: string): void => {
      statements.push(query);
    },
    max: 1,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const clock: MutableClock = new MutableClock(NOW);
  let root: PostgresMessageStore | null = null;
  try {
    for (const id of [tenant, other]) {
      await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name) VALUES (${id.value}::uuid, ${`expiry-${id.value}`}, 'Expiry preflight test')`;
      for (const agent of ["alice", "bob"]) {
        await admin`INSERT INTO murmur.agents(tenant_id, agent_id, display_name, created_at, last_seen_at)
          VALUES (${id.value}::uuid, ${agent}, ${agent}, ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
      }
    }
    const role: unknown =
      await app`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`;
    expect(role).toEqual([{ name: "murmur_app", rolbypassrls: false, rolsuper: false }]);
    root = await PostgresMessageStore.connect(databaseUrl, testTlsConfiguration, clock);
    await run({ admin, app, clock, other, statements, store: root.scope(tenant), tenant });
  } finally {
    try {
      if (root !== null) await root.close();
    } finally {
      try {
        await app.end({ timeout: 1 });
      } finally {
        try {
          for (const id of [tenant, other]) {
            await admin.begin(async (transaction: TransactionSql): Promise<void> => {
              await transaction`DELETE FROM murmur.e2ee_messages WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.e2ee_claims WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.e2ee_broadcasts WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.e2ee_key_bundles WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.messages WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.broadcasts WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.notices WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${id.value}::uuid`;
            });
          }
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    }
  }
}

async function encryptedCandidates(
  fixture: Fixture,
  now: Instant,
  tenant: TenantId = fixture.tenant,
): Promise<boolean> {
  return await fixture.app.begin(async (transaction: TransactionSql): Promise<boolean> => {
    await setPostgresTenantContext(transaction, tenant);
    return await queryPostgresE2eePruneCandidates(transaction, tenant, now);
  });
}

async function expectPlaintextBoundary(fixture: Fixture): Promise<void> {
  expect(await postgresHasPruneCandidates(fixture.app, fixture.tenant, BEFORE)).toBe(false);
  expect(await postgresHasPruneCandidates(fixture.app, fixture.tenant, NOW)).toBe(true);
  expect(await postgresHasPruneCandidates(fixture.app, fixture.other, NOW)).toBe(false);
}

test.skipIf(!postgresConfigured)(
  "empty PostgreSQL prune uses four protocol queries and no writes on each invocation",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      for (let repetition: number = 0; repetition < 2; repetition += 1) {
        fixture.statements.length = 0;
        expect(await postgresHasPruneCandidates(fixture.app, fixture.tenant, NOW)).toBe(false);
        expect(fixture.statements.length).toBe(4);
        expect(fixture.statements.join(" ")).not.toMatch(/\b(?:DELETE|UPDATE|INSERT)\b/iu);
        fixture.statements.length = 0;
        expect(await prunePostgresE2ee(fixture.app, fixture.tenant, NOW)).toBe(0);
        expect(fixture.statements.length).toBe(4);
        expect(fixture.statements.join(" ")).not.toMatch(/\b(?:DELETE|UPDATE|INSERT)\b/iu);
      }
      await fixture.admin`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${fixture.tenant.value}::uuid`;
      expect(await encryptedCandidates(fixture, NOW)).toBe(true);
      await expect(prunePostgresE2ee(fixture.app, fixture.tenant, NOW)).rejects.toThrow(
        "Tenant E2E usage state is unavailable",
      );
    });
  },
  20_000,
);

test.skipIf(!postgresConfigured)(
  "plaintext expiration immediately reclaims physical rows, quota, and an idempotency key",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      fixture.clock.set(NOW.addDays(-30));
      const sent: SendMessageResult = await fixture.store.sendMessage(baseMessageCommand());
      await fixture.admin`DELETE FROM murmur.agent_sessions WHERE tenant_id = ${fixture.tenant.value}::uuid`;
      await fixture.admin`UPDATE murmur.agents SET last_seen_at = ${NOW.toISOString()}::timestamptz WHERE tenant_id = ${fixture.tenant.value}::uuid`;
      await expectPlaintextBoundary(fixture);
      expect(await fixture.store.pruneExpired(BEFORE)).toBe(0);
      expect(await fixture.store.pruneExpired(NOW)).toBe(1);
      const usage: unknown =
        await fixture.admin`SELECT message_count::int AS count FROM murmur.tenant_resource_usage WHERE tenant_id = ${fixture.tenant.value}::uuid`;
      expect(usage).toEqual([{ count: 0 }]);
      const remaining: unknown =
        await fixture.admin`SELECT message_id FROM murmur.messages WHERE tenant_id = ${fixture.tenant.value}::uuid`;
      expect(remaining).toEqual([]);
      fixture.clock.set(NOW);
      const reused: SendMessageResult = await fixture.store.sendMessage(baseMessageCommand());
      expect(reused.duplicate).toBe(false);
      expect(reused.message.messageId.value).not.toBe(sent.message.messageId.value);
    });
  },
  20_000,
);

type PlaintextCase =
  | "broadcast"
  | "notice_expiry"
  | "notice_resolved"
  | "notice_withdrawn"
  | "live_lease"
  | "ended_lease"
  | "dormant_agent"
  | "closed_agent";
const plaintextCases: readonly PlaintextCase[] = [
  "broadcast",
  "notice_expiry",
  "notice_resolved",
  "notice_withdrawn",
  "live_lease",
  "ended_lease",
  "dormant_agent",
  "closed_agent",
];

async function seedPlaintextCandidate(fixture: Fixture, kind: PlaintextCase): Promise<void> {
  const id: string = fixture.tenant.value;
  const audit: string = NOW.addDays(-NOTICE_AUDIT_DAYS).toISOString();
  if (kind === "broadcast") {
    await fixture.admin`INSERT INTO murmur.broadcasts(tenant_id, broadcast_id, thread_id, sender_id, content, repository_name, branch_name, client_name, created_at, expires_at)
      VALUES (${id}::uuid, ${randomUUID()}::uuid, 'expiry-thread', 'alice', 'Synthetic expiry', 'murmur/expiry', 'test', 'codex', ${NOW.addDays(-30).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
  } else if (
    kind === "notice_expiry" ||
    kind === "notice_resolved" ||
    kind === "notice_withdrawn"
  ) {
    await fixture.admin`INSERT INTO murmur.notices(tenant_id, notice_id, kind, creator_id, creator_generation, repository_name, content, created_at, expires_at, resolved_at, resolved_by_id, resolved_by_generation, withdrawn_at, withdrawn_by_id, withdrawn_by_generation)
      VALUES (${id}::uuid, ${randomUUID()}::uuid, 'handoff', 'alice', 1, 'murmur/expiry', 'Synthetic notice', ${NOW.addDays(-NOTICE_AUDIT_DAYS - 1).toISOString()}::timestamptz,
        ${kind === "notice_expiry" ? audit : NOW.addDays(1).toISOString()}::timestamptz,
        ${kind === "notice_resolved" ? audit : null}::timestamptz, ${kind === "notice_resolved" ? "bob" : null}, ${kind === "notice_resolved" ? 1 : null},
        ${kind === "notice_withdrawn" ? audit : null}::timestamptz, ${kind === "notice_withdrawn" ? "alice" : null}, ${kind === "notice_withdrawn" ? 1 : null})`;
  } else if (kind === "live_lease" || kind === "ended_lease") {
    await fixture.admin`INSERT INTO murmur.agent_sessions(tenant_id, agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at, ended_at, end_reason)
      VALUES (${id}::uuid, 'alice', 1, 'expiry', ${NOW.addDays(-40).toISOString()}::timestamptz, ${NOW.addDays(-1).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz,
        ${kind === "ended_lease" ? NOW.addDays(-AGENT_GC_DAYS).toISOString() : null}::timestamptz, ${kind === "ended_lease" ? "stop" : null})`;
  } else if (kind === "dormant_agent") {
    await fixture.admin`UPDATE murmur.agents SET last_seen_at = ${NOW.addDays(-AGENT_DORMANCY_DAYS).toISOString()}::timestamptz WHERE tenant_id = ${id}::uuid AND agent_id = 'alice'`;
  } else {
    await fixture.admin`UPDATE murmur.agents SET closed_at = ${NOW.addDays(-AGENT_GC_DAYS).toISOString()}::timestamptz, close_reason = 'manual' WHERE tenant_id = ${id}::uuid AND agent_id = 'alice'`;
  }
}

for (const kind of plaintextCases) {
  test.skipIf(!postgresConfigured)(
    `plaintext ${kind} triggers cleanup exactly at its boundary in only its tenant`,
    async (): Promise<void> => {
      await withFixture(async (fixture: Fixture): Promise<void> => {
        await seedPlaintextCandidate(fixture, kind);
        await expectPlaintextBoundary(fixture);
        await fixture.store.pruneExpired(NOW);
        expect(await postgresHasPruneCandidates(fixture.app, fixture.tenant, NOW)).toBe(false);
      });
    },
    20_000,
  );
}

const PREKEY: string = `mpk_${"a".repeat(43)}`;
async function seedPrekey(fixture: Fixture, expires: Instant): Promise<void> {
  await fixture.admin`INSERT INTO murmur.e2ee_key_bundles(tenant_id, agent_id, agent_generation, root_key_id, agent_key_id, bundle_json, published_at)
    VALUES (${fixture.tenant.value}::uuid, 'bob', 1, ${`mrk_${"a".repeat(43)}`}, ${`mak_${"b".repeat(43)}`}, '{}', ${NOW.addDays(-1).toISOString()}::timestamptz)`;
  await fixture.admin`INSERT INTO murmur.e2ee_prekeys(tenant_id, prekey_id, agent_id, agent_generation, prekey_class, certificate_json, published_at, expires_at)
    VALUES (${fixture.tenant.value}::uuid, ${PREKEY}, 'bob', 1, 'one_time', '{}', ${NOW.addDays(-1).toISOString()}::timestamptz, ${expires.toISOString()}::timestamptz)`;
  await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET public_prekey_count = 1 WHERE tenant_id = ${fixture.tenant.value}::uuid`;
}

type EncryptedCase =
  | "message"
  | "direct_claim"
  | "consumed_claim"
  | "pending_broadcast"
  | "committed_broadcast"
  | "cancelled_broadcast"
  | "public_prekey";
const encryptedCases: readonly EncryptedCase[] = [
  "message",
  "direct_claim",
  "consumed_claim",
  "pending_broadcast",
  "committed_broadcast",
  "cancelled_broadcast",
  "public_prekey",
];

async function seedEncryptedCandidate(fixture: Fixture, kind: EncryptedCase): Promise<void> {
  const id: string = fixture.tenant.value;
  if (kind === "message") {
    await fixture.admin`INSERT INTO murmur.e2ee_messages(tenant_id, tenant_sequence, message_id, thread_id, sender_id, sender_generation, sender_authority, message_kind, recipient_id, recipient_generation, idempotency_key, pair_counter, envelope_json, sender_chain_json, ciphertext_bytes, created_at, expires_at)
      VALUES (${id}::uuid, 1, ${randomUUID()}::uuid, 'expiry', 'alice', 1, 'peer', 'message', 'bob', 1, 'expiry', 1, '{}', '{}', 17, ${NOW.addDays(-1).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
    await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET retained_message_count = 1, retained_ciphertext_bytes = 17 WHERE tenant_id = ${id}::uuid`;
  } else if (kind === "direct_claim" || kind === "consumed_claim") {
    await seedPrekey(fixture, NOW.addDays(1));
    await fixture.admin`INSERT INTO murmur.e2ee_claims(tenant_id, claim_id, sender_id, sender_generation, recipient_id, recipient_generation, prekey_id, message_kind, sender_authority, request_json, claim_json, created_at, expires_at, consumed_at)
      VALUES (${id}::uuid, ${randomUUID()}::uuid, 'alice', 1, 'bob', 1, ${PREKEY}, 'message', 'peer', '{}', '{}', ${NOW.addDays(-1).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz, ${kind === "consumed_claim" ? BEFORE.toISOString() : null}::timestamptz)`;
    await fixture.admin`UPDATE murmur.e2ee_prekeys SET claimed_at = ${BEFORE.toISOString()}::timestamptz WHERE tenant_id = ${id}::uuid`;
    await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET public_prekey_count = 0, claim_count = ${kind === "direct_claim" ? 1 : 0} WHERE tenant_id = ${id}::uuid`;
  } else if (kind === "public_prekey") {
    await seedPrekey(fixture, NOW);
  } else {
    const state: string =
      kind === "pending_broadcast"
        ? "pending"
        : kind === "committed_broadcast"
          ? "committed"
          : "cancelled";
    await fixture.admin`INSERT INTO murmur.e2ee_broadcasts(tenant_id, broadcast_id, sender_id, sender_generation, sender_authority, thread_id, request_json, recipient_count, state, created_at, expires_at)
      VALUES (${id}::uuid, ${randomUUID()}::uuid, 'alice', 1, 'peer', 'expiry', '{}', 0, ${state}, ${NOW.addDays(-1).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
    await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET pending_broadcast_count = ${state === "pending" ? 1 : 0} WHERE tenant_id = ${id}::uuid`;
  }
}

for (const kind of encryptedCases) {
  test.skipIf(!postgresConfigured)(
    `encrypted ${kind} retains exact expiry, physical reclamation, and usage accounting`,
    async (): Promise<void> => {
      await withFixture(async (fixture: Fixture): Promise<void> => {
        await seedEncryptedCandidate(fixture, kind);
        expect(await encryptedCandidates(fixture, BEFORE)).toBe(false);
        expect(await encryptedCandidates(fixture, NOW)).toBe(true);
        expect(await encryptedCandidates(fixture, NOW, fixture.other)).toBe(false);
        expect(await prunePostgresE2ee(fixture.app, fixture.tenant, BEFORE)).toBe(0);
        expect(await prunePostgresE2ee(fixture.app, fixture.tenant, NOW)).toBe(
          kind === "message" ? 1 : 0,
        );
        expect(await encryptedCandidates(fixture, NOW)).toBe(false);
        const rows: unknown = await fixture.admin`SELECT
        (SELECT count(*)::int FROM murmur.e2ee_messages WHERE tenant_id = ${fixture.tenant.value}::uuid) AS messages,
        (SELECT count(*)::int FROM murmur.e2ee_claims WHERE tenant_id = ${fixture.tenant.value}::uuid) AS claims,
        (SELECT count(*)::int FROM murmur.e2ee_broadcasts WHERE tenant_id = ${fixture.tenant.value}::uuid) AS broadcasts,
        (SELECT count(*)::int FROM murmur.e2ee_prekeys WHERE tenant_id = ${fixture.tenant.value}::uuid) AS prekeys`;
        expect(rows).toEqual([{ broadcasts: 0, claims: 0, messages: 0, prekeys: 0 }]);
        const usage: unknown =
          await fixture.admin`SELECT (claim_count + pending_broadcast_count + pending_ciphertext_bytes + pending_delivery_count + public_prekey_count + retained_ciphertext_bytes + retained_message_count)::int AS total FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${fixture.tenant.value}::uuid`;
        expect(usage).toEqual([{ total: 0 }]);
      });
    },
    20_000,
  );
}

for (const claimed of [false, true]) {
  test.skipIf(!postgresConfigured)(
    `encrypted ${claimed ? "claimed" : "retired"} unreferenced prekey is reclaimed before expiry`,
    async (): Promise<void> => {
      await withFixture(async (fixture: Fixture): Promise<void> => {
        await seedPrekey(fixture, NOW.addDays(1));
        expect(await encryptedCandidates(fixture, NOW)).toBe(false);
        await fixture.admin`UPDATE murmur.e2ee_prekeys SET claimed_at = ${claimed ? NOW.toISOString() : null}::timestamptz, retired_at = ${claimed ? null : NOW.toISOString()}::timestamptz WHERE tenant_id = ${fixture.tenant.value}::uuid`;
        await fixture.admin`UPDATE murmur.tenant_e2ee_usage SET public_prekey_count = 0 WHERE tenant_id = ${fixture.tenant.value}::uuid`;
        expect(await encryptedCandidates(fixture, NOW)).toBe(true);
        expect(await prunePostgresE2ee(fixture.app, fixture.tenant, NOW)).toBe(0);
        expect(await encryptedCandidates(fixture, NOW)).toBe(false);
      });
    },
    20_000,
  );
}
