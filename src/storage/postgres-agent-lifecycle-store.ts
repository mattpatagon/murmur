import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import {
  AgentAuthorityConflictError,
  AgentClosedError,
  StaleAgentGenerationError,
  UnknownAgentError,
} from "../domain/errors.js";
import {
  AGENT_LEASE_MINUTES,
  AgentGeneration,
  DEFAULT_SESSION_KEY,
  MAX_LIVE_SESSIONS_PER_AGENT,
  SessionKey,
} from "../domain/lifecycle-values.js";
import type {
  Agent,
  CloseAgentCommand,
  CloseAgentResult,
  EndSessionCommand,
  EndSessionResult,
  ListAgentsQuery,
  ListAgentsResult,
  RegisterAgentCommand,
  RegisterAgentResult,
} from "../domain/models.js";
import type { SenderAuthority } from "../domain/orchestration.js";
import {
  type AgentId,
  type Instant,
  type JsonObject,
  JsonObjectSchema,
  type TenantId,
} from "../domain/value-objects.js";
import {
  endExpiredPostgresSessions,
  postgresLiveSessionCount,
  repositoryFromMetadata,
  type StoredAgentRow,
  storedPostgresAgent,
  supersedePostgresSessions,
  trimRetainedPostgresSessions,
} from "./postgres-agent-lifecycle-rows.js";
import { type AgentRow, AgentRowSchema, mapAgentRow } from "./postgres-message-rows.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

function agentSelect(now: Instant): string {
  return now.toISOString();
}

export async function postgresAgentInTransaction(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  now: Instant,
): Promise<Agent> {
  const timestamp: string = agentSelect(now);
  const raw: unknown = await transaction`
    SELECT
      agent.agent_id,
      agent.authority,
      agent.display_name,
      agent.metadata::text AS metadata_json,
      agent.generation,
      agent.close_reason,
      to_char(agent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(agent.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at,
      CASE WHEN agent.closed_at IS NULL THEN NULL ELSE
        to_char(agent.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS closed_at,
      session.live_session_count,
      session.lease_expires_at,
      CASE
        WHEN agent.closed_at IS NOT NULL THEN 'closed'
        WHEN session.live_session_count > 0 THEN 'active'
        ELSE 'inactive'
      END AS state
    FROM murmur.agents AS agent
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*)::int AS live_session_count,
        CASE WHEN MAX(lease_expires_at) IS NULL THEN NULL ELSE
          to_char(MAX(lease_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS lease_expires_at
      FROM murmur.agent_sessions AS current_session
      WHERE current_session.tenant_id = agent.tenant_id
        AND current_session.agent_id = agent.agent_id
        AND current_session.generation = agent.generation
        AND current_session.ended_at IS NULL
        AND current_session.lease_expires_at > ${timestamp}::timestamptz
    ) AS session
    WHERE agent.tenant_id = ${tenantId.value}::uuid
      AND agent.agent_id = ${agentId.value}
  `;
  const rows: AgentRow[] = z.array(AgentRowSchema).parse(raw);
  const row: AgentRow | undefined = rows[0];
  if (row === undefined) throw new UnknownAgentError(agentId.value);
  return mapAgentRow(row);
}

export async function renewPostgresSessionInTransaction(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentId: AgentId,
  sessionKey: SessionKey,
  now: Instant,
  createIfMissing: boolean,
): Promise<Agent> {
  await endExpiredPostgresSessions(transaction, tenantId, now, agentId);
  const row: StoredAgentRow | null = await storedPostgresAgent(transaction, tenantId, agentId);
  if (row === null) throw new UnknownAgentError(agentId.value);
  if (row.closed_at !== null) {
    if (createIfMissing) throw new AgentClosedError(agentId.value);
    return await postgresAgentInTransaction(transaction, tenantId, agentId, now);
  }
  const generation: AgentGeneration = AgentGeneration.parse(row.generation);
  if (!createIfMissing) {
    if (!sessionKey.isDefault()) {
      await transaction`
        UPDATE murmur.agent_sessions
        SET
          last_renewed_at = ${now.toISOString()}::timestamptz,
          lease_expires_at = ${now.addMinutes(AGENT_LEASE_MINUTES).toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${agentId.value}
          AND generation = ${generation.value}
          AND session_key = ${sessionKey.value}
          AND ended_at IS NULL
      `;
    }
    return await postgresAgentInTransaction(transaction, tenantId, agentId, now);
  }

  const rawExisting: unknown = await transaction`
    SELECT 1 AS present FROM murmur.agent_sessions
    WHERE tenant_id = ${tenantId.value}::uuid
      AND agent_id = ${agentId.value}
      AND generation = ${generation.value}
      AND session_key = ${sessionKey.value}
      AND ended_at IS NULL
      AND lease_expires_at > ${now.toISOString()}::timestamptz
  `;
  const existing: { readonly present: number }[] = z
    .array(z.strictObject({ present: z.number().int() }))
    .parse(rawExisting);
  if (
    existing.length === 0 &&
    (await postgresLiveSessionCount(transaction, tenantId, agentId, generation, now)) >=
      MAX_LIVE_SESSIONS_PER_AGENT
  ) {
    await transaction`
      UPDATE murmur.agent_sessions AS target
      SET ended_at = ${now.toISOString()}::timestamptz, end_reason = 'superseded'
      FROM (
        SELECT tenant_id, agent_id, generation, session_key
        FROM murmur.agent_sessions
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${agentId.value}
          AND generation = ${generation.value}
          AND ended_at IS NULL
        ORDER BY lease_expires_at ASC, session_key ASC
        LIMIT 1
      ) AS stale
      WHERE target.tenant_id = stale.tenant_id
        AND target.agent_id = stale.agent_id
        AND target.generation = stale.generation
        AND target.session_key = stale.session_key
    `;
  }
  await transaction`
    INSERT INTO murmur.agent_sessions(
      tenant_id, agent_id, generation, session_key,
      started_at, last_renewed_at, lease_expires_at
    ) VALUES (
      ${tenantId.value}::uuid, ${agentId.value}, ${generation.value}, ${sessionKey.value},
      ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz,
      ${now.addMinutes(AGENT_LEASE_MINUTES).toISOString()}::timestamptz
    )
    ON CONFLICT(tenant_id, agent_id, generation, session_key) DO UPDATE SET
      last_renewed_at = excluded.last_renewed_at,
      lease_expires_at = excluded.lease_expires_at,
      ended_at = NULL,
      end_reason = NULL
  `;
  await trimRetainedPostgresSessions(transaction, tenantId, agentId);
  await transaction`
    UPDATE murmur.agents SET last_seen_at = ${now.toISOString()}::timestamptz
    WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${agentId.value}
  `;
  return await postgresAgentInTransaction(transaction, tenantId, agentId, now);
}

function divergentMetadata(currentJson: string, incoming: JsonObject): JsonObject {
  const current: JsonObject = JsonObjectSchema.parse(JSON.parse(currentJson));
  const repository: string | null = repositoryFromMetadata(current);
  return { ...incoming, ...(repository === null ? {} : { repository }) };
}

export async function registerPostgresAgent(
  database: Sql,
  tenantId: TenantId,
  command: RegisterAgentCommand,
  now: Instant,
): Promise<RegisterAgentResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<RegisterAgentResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      command.agentId.value,
    ]);
    await endExpiredPostgresSessions(transaction, tenantId, now, command.agentId);
    const existing: StoredAgentRow | null = await storedPostgresAgent(
      transaction,
      tenantId,
      command.agentId,
    );
    let generation: AgentGeneration = AgentGeneration.parse(
      existing === null ? 1 : existing.generation,
    );
    let metadata: JsonObject = command.metadata;
    const authority: SenderAuthority = command.authority ?? "peer";
    let reopened: boolean = false;
    let repositoryDiverged: boolean = false;
    if (existing === null) {
      await transaction`
        INSERT INTO murmur.agents(
          tenant_id, agent_id, authority, display_name, metadata, created_at, last_seen_at
        ) VALUES (
          ${tenantId.value}::uuid, ${command.agentId.value}, ${authority},
          ${command.displayName.value},
          ${database.json(metadata)}, ${now.toISOString()}::timestamptz,
          ${now.toISOString()}::timestamptz
        )
      `;
    } else {
      if (existing.authority !== authority) throw new AgentAuthorityConflictError();
      const currentMetadata: JsonObject = JsonObjectSchema.parse(
        JSON.parse(existing.metadata_json),
      );
      const currentRepository: string | null = repositoryFromMetadata(currentMetadata);
      const incomingRepository: string | null = repositoryFromMetadata(command.metadata);
      const repositoryChanged: boolean =
        currentRepository !== null &&
        incomingRepository !== null &&
        currentRepository !== incomingRepository;
      const currentLive: number = await postgresLiveSessionCount(
        transaction,
        tenantId,
        command.agentId,
        generation,
        now,
      );
      if (existing.closed_at !== null) {
        const dormantSameRepository: boolean =
          existing.close_reason === "dormant" && !repositoryChanged;
        if (!dormantSameRepository) generation = generation.next();
        reopened = true;
        await supersedePostgresSessions(
          transaction,
          tenantId,
          command.agentId,
          AgentGeneration.parse(existing.generation),
          now,
        );
      } else if (repositoryChanged && currentLive > 0) {
        repositoryDiverged = true;
        metadata = divergentMetadata(existing.metadata_json, command.metadata);
      } else if (repositoryChanged) {
        await supersedePostgresSessions(transaction, tenantId, command.agentId, generation, now);
        generation = generation.next();
        reopened = true;
      }
      await transaction`
        UPDATE murmur.agents SET
          display_name = ${command.displayName.value},
          metadata = ${database.json(metadata)},
          generation = ${generation.value},
          closed_at = NULL,
          close_reason = NULL,
          last_seen_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${command.agentId.value}
      `;
    }
    const agent: Agent = await renewPostgresSessionInTransaction(
      transaction,
      tenantId,
      command.agentId,
      command.sessionKey ?? SessionKey.default(),
      now,
      true,
    );
    return { agent, reopened, repositoryDiverged };
  });
}

export async function getPostgresAgent(
  database: Sql,
  tenantId: TenantId,
  agentId: AgentId,
  now: Instant,
): Promise<Agent | null> {
  return await database.begin(async (transaction: TransactionSql): Promise<Agent | null> => {
    await setPostgresTenantContext(transaction, tenantId);
    const existing: StoredAgentRow | null = await storedPostgresAgent(
      transaction,
      tenantId,
      agentId,
    );
    return existing === null
      ? null
      : await postgresAgentInTransaction(transaction, tenantId, agentId, now);
  });
}

export async function listPostgresAgents(
  database: Sql,
  tenantId: TenantId,
  query: ListAgentsQuery,
  now: Instant,
): Promise<ListAgentsResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<ListAgentsResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await endExpiredPostgresSessions(transaction, tenantId, now);
    const cursor: string | null = query.cursor === null ? null : query.cursor.value;
    const raw: unknown = await transaction`
      SELECT
        agent.agent_id,
        agent.authority,
        agent.display_name,
        agent.metadata::text AS metadata_json,
        agent.generation,
        agent.close_reason,
        to_char(agent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(agent.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at,
        CASE WHEN agent.closed_at IS NULL THEN NULL ELSE
          to_char(agent.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS closed_at,
        session.live_session_count,
        session.lease_expires_at,
        CASE
          WHEN agent.closed_at IS NOT NULL THEN 'closed'
          WHEN session.live_session_count > 0 THEN 'active'
          ELSE 'inactive'
        END AS state
      FROM murmur.agents AS agent
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::int AS live_session_count,
          CASE WHEN MAX(lease_expires_at) IS NULL THEN NULL ELSE
            to_char(MAX(lease_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS lease_expires_at
        FROM murmur.agent_sessions AS current_session
        WHERE current_session.tenant_id = agent.tenant_id
          AND current_session.agent_id = agent.agent_id
          AND current_session.generation = agent.generation
          AND current_session.ended_at IS NULL
          AND current_session.lease_expires_at > ${now.toISOString()}::timestamptz
      ) AS session
      WHERE agent.tenant_id = ${tenantId.value}::uuid AND (
        ${query.state} = 'all'
        OR (${query.state} = 'open' AND agent.closed_at IS NULL)
        OR (${query.state} = 'closed' AND agent.closed_at IS NOT NULL)
        OR (${query.state} = 'active' AND agent.closed_at IS NULL
          AND session.live_session_count > 0)
        OR (${query.state} = 'inactive' AND agent.closed_at IS NULL
          AND session.live_session_count = 0)
      )
      AND (${cursor}::text IS NULL OR agent.agent_id > ${cursor}::text)
      ORDER BY agent.agent_id ASC
      LIMIT ${query.limit + 1}
    `;
    const rows: Agent[] = z.array(AgentRowSchema).parse(raw).map(mapAgentRow);
    const agents: Agent[] = rows.slice(0, query.limit);
    let nextCursor: AgentId | null = null;
    if (rows.length > query.limit) {
      const lastAgent: Agent | undefined = agents.at(-1);
      if (lastAgent === undefined) throw new Error("Agent page unexpectedly has no cursor row");
      nextCursor = lastAgent.agentId;
    }
    return { agents, nextCursor };
  });
}

export async function endPostgresSession(
  database: Sql,
  tenantId: TenantId,
  command: EndSessionCommand,
  now: Instant,
): Promise<EndSessionResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<EndSessionResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      command.agentId.value,
    ]);
    const row: StoredAgentRow | null = await storedPostgresAgent(
      transaction,
      tenantId,
      command.agentId,
    );
    if (row === null) return { ended: 0, generation: null };
    const generation: AgentGeneration = AgentGeneration.parse(row.generation);
    if (!generation.equals(command.expectedGeneration)) {
      throw new StaleAgentGenerationError(command.agentId.value);
    }
    const keys: string[] = [command.sessionKey.value];
    if (command.endDefaultSession && command.sessionKey.value !== DEFAULT_SESSION_KEY) {
      keys.push(DEFAULT_SESSION_KEY);
    }
    const raw: unknown = await transaction`
      UPDATE murmur.agent_sessions
      SET ended_at = ${now.toISOString()}::timestamptz, end_reason = ${command.endReason}
      WHERE tenant_id = ${tenantId.value}::uuid
        AND agent_id = ${command.agentId.value}
        AND generation = ${generation.value}
        AND session_key = ANY(${database.array(keys)}::text[])
        AND ended_at IS NULL
      RETURNING 1 AS ended
    `;
    const ended: { readonly ended: number }[] = z
      .array(z.strictObject({ ended: z.number().int() }))
      .parse(raw);
    await transaction`
      UPDATE murmur.agents SET last_seen_at = ${now.toISOString()}::timestamptz
      WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${command.agentId.value}
    `;
    return { ended: ended.length, generation };
  });
}

export async function closePostgresAgent(
  database: Sql,
  tenantId: TenantId,
  command: CloseAgentCommand,
  now: Instant,
): Promise<CloseAgentResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<CloseAgentResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      command.agentId.value,
    ]);
    const row: StoredAgentRow | null = await storedPostgresAgent(
      transaction,
      tenantId,
      command.agentId,
    );
    if (row === null) throw new UnknownAgentError(command.agentId.value);
    const generation: AgentGeneration = AgentGeneration.parse(row.generation);
    if (!generation.equals(command.expectedGeneration)) {
      throw new StaleAgentGenerationError(command.agentId.value);
    }
    const alreadyClosed: boolean = row.closed_at !== null;
    let endedSessions: number = 0;
    if (!alreadyClosed) {
      await transaction`
        UPDATE murmur.agents SET
          closed_at = ${now.toISOString()}::timestamptz,
          close_reason = ${command.closeReason},
          last_seen_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${command.agentId.value}
      `;
      const endedRaw: unknown = await transaction`
        UPDATE murmur.agent_sessions
        SET ended_at = ${now.toISOString()}::timestamptz, end_reason = 'closed'
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${command.agentId.value}
          AND generation = ${generation.value}
          AND ended_at IS NULL
        RETURNING 1 AS ended
      `;
      endedSessions = z.array(z.strictObject({ ended: z.number().int() })).parse(endedRaw).length;
    }
    const unreadRaw: unknown = await transaction`
      SELECT COUNT(*)::int AS count FROM murmur.messages
      WHERE tenant_id = ${tenantId.value}::uuid
        AND recipient_id = ${command.agentId.value}
        AND recipient_generation = ${generation.value}
        AND read_at IS NULL
        AND expires_at > ${now.toISOString()}::timestamptz
    `;
    const unreadRows: { readonly count: number }[] = z
      .array(z.strictObject({ count: z.number().int().nonnegative() }))
      .parse(unreadRaw);
    return {
      agent: await postgresAgentInTransaction(transaction, tenantId, command.agentId, now),
      alreadyClosed,
      endedSessions,
      unreadCount: unreadRows[0] === undefined ? 0 : unreadRows[0].count,
    };
  });
}
