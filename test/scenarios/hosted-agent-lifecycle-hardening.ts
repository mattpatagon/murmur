import { expect } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { AgentGeneration, NoticeContent, SessionKey } from "../../src/domain/lifecycle-values.js";
import {
  FeedbackDescription,
  FeedbackTitle,
  type SubmitFeedbackResult,
} from "../../src/domain/feedback-models.js";
import type { Agent, ListAgentsResult, RegisterAgentResult } from "../../src/domain/models.js";
import {
  AgentId,
  AgentClient,
  BranchName,
  DisplayName,
  IdempotencyKey,
  Instant,
  RepositoryName,
  TenantId,
} from "../../src/domain/value-objects.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import type { MessageStore } from "../../src/storage/message-store.js";
import {
  POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED,
  PostgresMessageStore,
} from "../../src/storage/postgres-message-store.js";
import { MutableClock } from "../support/store-fixture.js";
import { databaseUrl, testTlsConfiguration } from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

async function register(
  store: MessageStore,
  agentId: string,
  sessionKey: string,
): Promise<RegisterAgentResult> {
  return await store.registerAgent({
    agentId: AgentId.parse(agentId),
    displayName: DisplayName.parse(agentId),
    metadata: { repository: "mattpatagon/murmur" },
    sessionKey: SessionKey.parse(sessionKey),
  });
}

async function verifyNoticeRetainsGeneration(
  store: MessageStore,
  clock: MutableClock,
  agentId: string,
): Promise<void> {
  await register(store, agentId, "generation-one");
  await store.closeAgent({
    agentId: AgentId.parse(agentId),
    closeReason: "manual",
    expectedGeneration: AgentGeneration.parse(1),
  });
  const second: RegisterAgentResult = await register(store, agentId, "generation-two");
  expect(second.agent.generation.value).toBe(2);
  await store.postNotice({
    actorId: AgentId.parse(agentId),
    branchName: null,
    content: NoticeContent.parse("retain hosted creator lineage"),
    expiresInHours: 90 * 24,
    idempotencyKey: IdempotencyKey.parse("hosted-retain-lineage"),
    kind: "decision",
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    sessionKey: SessionKey.parse("generation-two"),
  });
  await store.closeAgent({
    agentId: AgentId.parse(agentId),
    closeReason: "manual",
    expectedGeneration: AgentGeneration.parse(2),
  });
  clock.set(clock.now().addDays(31));
  await store.pruneExpired(clock.now());
  const third: RegisterAgentResult = await register(store, agentId, "generation-three");
  expect(third.agent.generation.value).toBe(3);
  await store.closeAgent({
    agentId: AgentId.parse(agentId),
    closeReason: "manual",
    expectedGeneration: AgentGeneration.parse(3),
  });
  clock.set(clock.now().addDays(91));
  await store.pruneExpired(clock.now());
  expect(await store.getAgent(AgentId.parse(agentId))).toBeNull();
}

async function verifyFeedbackRetainsGeneration(
  store: MessageStore,
  clock: MutableClock,
  agentId: string,
): Promise<void> {
  await register(store, agentId, "generation-one");
  const first: SubmitFeedbackResult = await store.submitFeedback({
    branchName: BranchName.parse("feature/feedback-lineage"),
    client: AgentClient.parse("codex"),
    description: FeedbackDescription.parse("retain hosted feedback reporter lineage"),
    idempotencyKey: IdempotencyKey.parse("hosted-feedback-lineage-one"),
    reporterId: AgentId.parse(agentId),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    sessionKey: SessionKey.parse("generation-one"),
    title: FeedbackTitle.parse("Retain reporter lineage"),
    type: "issue",
  });
  expect(first.submission.reporterGeneration.value).toBe(1);
  await store.closeAgent({
    agentId: AgentId.parse(agentId),
    closeReason: "manual",
    expectedGeneration: AgentGeneration.parse(1),
  });
  clock.set(clock.now().addDays(31));
  await store.pruneExpired(clock.now());
  const second: RegisterAgentResult = await register(store, agentId, "generation-two");
  expect(second.agent.generation.value).toBe(2);
  const feedback: SubmitFeedbackResult = await store.submitFeedback({
    branchName: BranchName.parse("feature/feedback-lineage"),
    client: AgentClient.parse("codex"),
    description: FeedbackDescription.parse("record the next reporter generation"),
    idempotencyKey: IdempotencyKey.parse("hosted-feedback-lineage-two"),
    reporterId: AgentId.parse(agentId),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    sessionKey: SessionKey.parse("generation-two"),
    title: FeedbackTitle.parse("Record reporter generation"),
    type: "feature_request",
  });
  expect(feedback.submission.reporterGeneration.value).toBe(2);
}

async function waitForAdvisoryWaiter(transaction: TransactionSql): Promise<void> {
  for (let attempt: number = 0; attempt < 100; attempt += 1) {
    const rows: { readonly waiting: boolean }[] = await transaction<
      { readonly waiting: boolean }[]
    >`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks
        WHERE locktype = 'advisory' AND NOT granted
      ) AS waiting
    `;
    const row: { readonly waiting: boolean } | undefined = rows[0];
    if (row !== undefined && row.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Lifecycle prune did not wait on the per-agent advisory lock");
}

async function verifyPruneRechecksAfterLockedRenewal(
  admin: Sql,
  store: MessageStore,
  clock: MutableClock,
  tenantId: string,
  agentId: string,
): Promise<void> {
  await register(store, agentId, "original");
  clock.set(clock.now().addDays(31));
  let prunePromise: Promise<number> | null = null;
  await admin.begin(async (transaction: TransactionSql): Promise<void> => {
    await transaction`
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${tenantId}::text || ':' || ${agentId},
          ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
        )
      )
    `;
    prunePromise = Promise.resolve(store.pruneExpired(clock.now()));
    await waitForAdvisoryWaiter(transaction);
    await transaction`
      UPDATE murmur.agents
      SET last_seen_at = ${clock.now().toISOString()}::timestamptz
      WHERE tenant_id = ${tenantId}::uuid AND agent_id = ${agentId}
    `;
    await transaction`
      INSERT INTO murmur.agent_sessions(
        tenant_id, agent_id, generation, session_key,
        started_at, last_renewed_at, lease_expires_at
      ) VALUES (
        ${tenantId}::uuid, ${agentId}, 1, 'race-winner',
        ${clock.now().toISOString()}::timestamptz,
        ${clock.now().toISOString()}::timestamptz,
        ${clock.now().addMinutes(60).toISOString()}::timestamptz
      )
    `;
  });
  const pending: Promise<number> | null = prunePromise;
  if (pending === null) throw new Error("Lifecycle prune was not started");
  await pending;
  const agent: Agent | null = await store.getAgent(AgentId.parse(agentId));
  if (agent === null) throw new Error("Race-test agent was garbage-collected");
  expect(agent.state).toBe("active");
  expect(agent.closedAt).toBeNull();
}

async function verifyRetainedAgentPagination(
  admin: Sql,
  store: MessageStore,
  clock: MutableClock,
  tenantId: string,
  unique: string,
): Promise<void> {
  const prefix: string = `pagination-${unique}-`;
  const timestamp: string = clock.now().toISOString();
  try {
    await admin`
      INSERT INTO murmur.agents(
        tenant_id, agent_id, display_name, metadata,
        created_at, last_seen_at, generation, closed_at, close_reason
      )
      SELECT
        ${tenantId}::uuid,
        ${prefix} || lpad(value::text, 4, '0'),
        ${prefix} || lpad(value::text, 4, '0'),
        '{}'::jsonb,
        ${timestamp}::timestamptz,
        ${timestamp}::timestamptz,
        1,
        ${timestamp}::timestamptz,
        'manual'
      FROM generate_series(1, 1001) AS value
    `;
    const matchingAgentIds: string[] = [];
    let cursor: AgentId | null = null;
    do {
      const page: ListAgentsResult = await store.listAgents({
        cursor,
        limit: 137,
        state: "closed",
      });
      matchingAgentIds.push(
        ...page.agents
          .map((agent: Agent): string => agent.agentId.value)
          .filter((agentId: string): boolean => agentId.startsWith(prefix)),
      );
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(matchingAgentIds).toHaveLength(1_001);
    expect(new Set(matchingAgentIds).size).toBe(1_001);
    expect(matchingAgentIds).toEqual([...matchingAgentIds].sort());
  } finally {
    await admin`
      DELETE FROM murmur.agents
      WHERE tenant_id = ${tenantId}::uuid
        AND agent_id LIKE ${`${prefix}%`}
    `;
  }
}

export async function verifyHostedAgentLifecycleHardening(
  scenario: HostedTenantScenario,
): Promise<void> {
  const configuredDatabaseUrl: string | undefined = databaseUrl;
  const adminUrl: string | undefined = scenario.configuredAdminDatabaseUrl;
  if (configuredDatabaseUrl === undefined || adminUrl === undefined) {
    throw new Error("PostgreSQL URLs are required");
  }
  const clock: MutableClock = new MutableClock(Instant.parse(new Date().toISOString()));
  const root: PostgresMessageStore = await PostgresMessageStore.connect(
    configuredDatabaseUrl,
    testTlsConfiguration,
    clock,
  );
  const tenantId: string = scenario.tenantA.tenant.tenant_id;
  const store: MessageStore = root.scope(TenantId.parse(tenantId));
  const admin: Sql = postgres(adminUrl, {
    max: 2,
    ssl: postgresSslOptions(adminUrl, testTlsConfiguration),
  });
  try {
    await verifyNoticeRetainsGeneration(
      store,
      clock,
      `lifecycle-notice-retention-${scenario.unique}`,
    );
    await verifyFeedbackRetainsGeneration(
      store,
      clock,
      `lifecycle-feedback-retention-${scenario.unique}`,
    );
    await verifyPruneRechecksAfterLockedRenewal(
      admin,
      store,
      clock,
      tenantId,
      `lifecycle-prune-race-${scenario.unique}`,
    );
    await verifyRetainedAgentPagination(admin, store, clock, tenantId, scenario.unique);
  } finally {
    await Promise.allSettled([admin.end({ timeout: 5 }), root.close()]);
  }
}
