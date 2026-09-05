import type { Database, Statement } from "bun:sqlite";

import {
  AgentCapacityError,
  AgentClosedError,
  StaleAgentGenerationError,
  UnknownAgentError,
} from "../domain/errors.js";
import {
  AGENT_LEASE_MINUTES,
  AgentGeneration,
  DEFAULT_SESSION_KEY,
  MAX_LIVE_SESSIONS_PER_AGENT,
  MAX_OPEN_AGENTS,
  MAX_RETAINED_AGENTS,
  type SessionEndReason,
  SessionKey,
} from "../domain/lifecycle-values.js";
import type {
  Agent,
  CloseAgentCommand,
  CloseAgentResult,
  EndSessionCommand,
  EndSessionResult,
  RegisterAgentCommand,
  RegisterAgentResult,
} from "../domain/models.js";
import { type SenderAuthority, SenderAuthoritySchema } from "../domain/orchestration.js";
import {
  type AgentId,
  type Instant,
  type JsonObject,
  JsonObjectSchema,
} from "../domain/value-objects.js";
import {
  endExpiredSqliteSessions,
  sqliteLiveSessionCount,
  trimRetainedSqliteSessions,
} from "./sqlite-agent-session-rows.js";
import { mapAgentRow } from "./sqlite-message-rows.js";

type StoredAgentRow = {
  readonly agent_id: string;
  readonly authority: SenderAuthority;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
  readonly generation: number;
  readonly metadata_json: string;
};
function repositoryFromMetadata(metadata: JsonObject): string | null {
  const repository: unknown = metadata["repository"];
  return typeof repository === "string" ? repository : null;
}
function storedAgent(database: Database, agentId: AgentId): StoredAgentRow | null {
  const raw: unknown = database
    .query<unknown, [string]>(`
      SELECT agent_id, authority, closed_at, close_reason, generation, metadata_json
      FROM agents WHERE agent_id = ?
    `)
    .get(agentId.value);
  if (raw === null) return null;
  if (typeof raw !== "object") throw new Error("Stored agent row is invalid");
  const generation: unknown = Reflect.get(raw, "generation");
  if (typeof generation !== "number" && typeof generation !== "bigint") {
    throw new Error("Stored agent generation is invalid");
  }
  const authority: SenderAuthority = SenderAuthoritySchema.parse(Reflect.get(raw, "authority"));
  return {
    agent_id: String(Reflect.get(raw, "agent_id")),
    authority,
    closed_at:
      Reflect.get(raw, "closed_at") === null ? null : String(Reflect.get(raw, "closed_at")),
    close_reason:
      Reflect.get(raw, "close_reason") === null ? null : String(Reflect.get(raw, "close_reason")),
    generation: Number(generation),
    metadata_json: String(Reflect.get(raw, "metadata_json")),
  };
}
function mergeDivergentMetadata(currentJson: string, incoming: JsonObject): JsonObject {
  const parsed: unknown = JSON.parse(currentJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored agent metadata is invalid");
  }
  const currentRepository: unknown = Reflect.get(parsed, "repository");
  return {
    ...incoming,
    ...(typeof currentRepository === "string" ? { repository: currentRepository } : {}),
  };
}
function ensureOpenCapacity(database: Database): void {
  const row: unknown = database
    .query<unknown, []>("SELECT COUNT(*) AS count FROM agents WHERE closed_at IS NULL")
    .get();
  if (row === null || typeof row !== "object") throw new Error("Agent count is invalid");
  const count: unknown = Reflect.get(row, "count");
  if (typeof count !== "number" && typeof count !== "bigint") {
    throw new Error("Agent count is invalid");
  }
  if (Number(count) >= MAX_OPEN_AGENTS) throw new AgentCapacityError();
}
function ensureRetainedCapacity(database: Database): void {
  const row: unknown = database.query<unknown, []>("SELECT COUNT(*) AS count FROM agents").get();
  if (row === null || typeof row !== "object") throw new Error("Agent count is invalid");
  const count: unknown = Reflect.get(row, "count");
  if (typeof count !== "number" && typeof count !== "bigint") {
    throw new Error("Agent count is invalid");
  }
  if (Number(count) >= MAX_RETAINED_AGENTS) throw new AgentCapacityError();
}
function supersedeSessions(
  database: Database,
  agentId: AgentId,
  generation: AgentGeneration,
  now: Instant,
): void {
  database
    .query<unknown, [string, string, number]>(`
      UPDATE agent_sessions SET ended_at = ?, end_reason = 'superseded'
      WHERE agent_id = ? AND generation = ? AND ended_at IS NULL
    `)
    .run(now.toISOString(), agentId.value, generation.value);
}
export function renewSqliteSession(
  database: Database,
  agentId: AgentId,
  sessionKey: SessionKey,
  now: Instant,
  createIfMissing: boolean,
): Agent {
  endExpiredSqliteSessions(database, now, agentId);
  const row: StoredAgentRow | null = storedAgent(database, agentId);
  if (row === null) throw new UnknownAgentError(agentId.value);
  if (row.closed_at !== null) {
    if (createIfMissing) throw new AgentClosedError(agentId.value);
    return sqliteAgent(database, agentId, now);
  }
  const generation: AgentGeneration = AgentGeneration.parse(row.generation);
  if (!createIfMissing) {
    if (sessionKey.isDefault()) return sqliteAgent(database, agentId, now);
    database
      .query<unknown, [string, string, string, number, string]>(`
        UPDATE agent_sessions
        SET last_renewed_at = ?, lease_expires_at = ?
        WHERE agent_id = ? AND generation = ? AND session_key = ? AND ended_at IS NULL
      `)
      .run(
        now.toISOString(),
        now.addMinutes(AGENT_LEASE_MINUTES).toISOString(),
        agentId.value,
        generation.value,
        sessionKey.value,
      );
    return sqliteAgent(database, agentId, now);
  }

  const existing: unknown = database
    .query<unknown, [string, number, string, string]>(`
      SELECT 1 AS present FROM agent_sessions
      WHERE agent_id = ? AND generation = ? AND session_key = ?
        AND ended_at IS NULL AND lease_expires_at > ?
    `)
    .get(agentId.value, generation.value, sessionKey.value, now.toISOString());
  if (
    existing === null &&
    sqliteLiveSessionCount(database, agentId, generation, now) >= MAX_LIVE_SESSIONS_PER_AGENT
  ) {
    database
      .query<unknown, [string, string, number]>(`
        UPDATE agent_sessions SET ended_at = ?, end_reason = 'superseded'
        WHERE rowid = (
          SELECT rowid FROM agent_sessions
          WHERE agent_id = ? AND generation = ? AND ended_at IS NULL
          ORDER BY lease_expires_at ASC, session_key ASC LIMIT 1
        )
      `)
      .run(now.toISOString(), agentId.value, generation.value);
  }
  database
    .query<unknown, [string, number, string, string, string, string]>(`
      INSERT INTO agent_sessions(
        agent_id, generation, session_key, started_at, last_renewed_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, generation, session_key) DO UPDATE SET
        last_renewed_at = excluded.last_renewed_at,
        lease_expires_at = excluded.lease_expires_at,
        ended_at = NULL,
        end_reason = NULL
    `)
    .run(
      agentId.value,
      generation.value,
      sessionKey.value,
      now.toISOString(),
      now.toISOString(),
      now.addMinutes(AGENT_LEASE_MINUTES).toISOString(),
    );
  trimRetainedSqliteSessions(database, agentId);
  database
    .query<unknown, [string, string]>("UPDATE agents SET last_seen_at = ? WHERE agent_id = ?")
    .run(now.toISOString(), agentId.value);
  return sqliteAgent(database, agentId, now);
}

export function sqliteAgent(database: Database, agentId: AgentId, now: Instant): Agent {
  const row: unknown = database
    .query<unknown, [string, string, string, string]>(`
      SELECT
        agent.*,
        (SELECT COUNT(*) FROM agent_sessions AS session
          WHERE session.agent_id = agent.agent_id
            AND session.generation = agent.generation
            AND session.ended_at IS NULL
            AND session.lease_expires_at > ?) AS live_session_count,
        (SELECT MAX(session.lease_expires_at) FROM agent_sessions AS session
          WHERE session.agent_id = agent.agent_id
            AND session.generation = agent.generation
            AND session.ended_at IS NULL
            AND session.lease_expires_at > ?) AS lease_expires_at,
        CASE
          WHEN agent.closed_at IS NOT NULL THEN 'closed'
          WHEN EXISTS (
            SELECT 1 FROM agent_sessions AS session
            WHERE session.agent_id = agent.agent_id
              AND session.generation = agent.generation
              AND session.ended_at IS NULL
              AND session.lease_expires_at > ?
          ) THEN 'active'
          ELSE 'inactive'
        END AS state
      FROM agents AS agent WHERE agent.agent_id = ?
    `)
    .get(now.toISOString(), now.toISOString(), now.toISOString(), agentId.value);
  if (row === null) throw new UnknownAgentError(agentId.value);
  return mapAgentRow(row);
}

export function registerSqliteAgent(
  database: Database,
  command: RegisterAgentCommand,
  now: Instant,
): RegisterAgentResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    endExpiredSqliteSessions(database, now, command.agentId);
    const existing: StoredAgentRow | null = storedAgent(database, command.agentId);
    let generation: AgentGeneration = AgentGeneration.parse(
      existing === null ? 1 : existing.generation,
    );
    let metadata: JsonObject = command.metadata;
    let becameActive: boolean = existing === null;
    let reopened: boolean = false;
    let repositoryDiverged: boolean = false;
    if (existing === null) {
      ensureRetainedCapacity(database);
      ensureOpenCapacity(database);
      database
        .query<unknown, [string, string, string, string, string, string]>(`
          INSERT INTO agents(
            agent_id, authority, display_name, metadata_json, created_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          command.agentId.value,
          command.authority ?? "peer",
          command.displayName.value,
          JSON.stringify(metadata),
          now.toISOString(),
          now.toISOString(),
        );
    } else {
      if (existing.authority !== (command.authority ?? "peer")) {
        throw new Error("The agent ID is reserved for a different authority");
      }
      const currentMetadata: JsonObject = JsonObjectSchema.parse(
        JSON.parse(existing.metadata_json),
      );
      const currentRepository: string | null = repositoryFromMetadata(currentMetadata);
      const incomingRepository: string | null = repositoryFromMetadata(command.metadata);
      const repositoryChanged: boolean =
        currentRepository !== null &&
        incomingRepository !== null &&
        currentRepository !== incomingRepository;
      const currentLive: number = sqliteLiveSessionCount(
        database,
        command.agentId,
        generation,
        now,
      );
      becameActive = existing.closed_at !== null || currentLive === 0;
      if (existing.closed_at !== null) {
        ensureOpenCapacity(database);
        const dormantSameRepository: boolean =
          existing.close_reason === "dormant" && !repositoryChanged;
        if (!dormantSameRepository) generation = generation.next();
        reopened = true;
        supersedeSessions(
          database,
          command.agentId,
          AgentGeneration.parse(existing.generation),
          now,
        );
      } else if (repositoryChanged && currentLive > 0) {
        repositoryDiverged = true;
        metadata = mergeDivergentMetadata(existing.metadata_json, command.metadata);
      } else if (repositoryChanged) {
        supersedeSessions(database, command.agentId, generation, now);
        generation = generation.next();
        reopened = true;
      }
      database
        .query<unknown, [string, string, number, string, string]>(`
          UPDATE agents SET
            display_name = ?, metadata_json = ?, generation = ?,
            closed_at = NULL, close_reason = NULL, last_seen_at = ?
          WHERE agent_id = ?
        `)
        .run(
          command.displayName.value,
          JSON.stringify(metadata),
          generation.value,
          now.toISOString(),
          command.agentId.value,
        );
    }
    const agent: Agent = renewSqliteSession(
      database,
      command.agentId,
      command.sessionKey ?? SessionKey.default(),
      now,
      true,
    );
    const result: RegisterAgentResult = {
      agent,
      becameActive: becameActive && agent.state === "active",
      reopened,
      repositoryDiverged,
    };
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
export { listSqliteAgents } from "./sqlite-agent-page.js";
export function endSqliteSession(
  database: Database,
  command: EndSessionCommand,
  now: Instant,
): EndSessionResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row: StoredAgentRow | null = storedAgent(database, command.agentId);
    if (row === null) {
      database.exec("COMMIT");
      return { ended: 0, generation: null };
    }
    const generation: AgentGeneration = AgentGeneration.parse(row.generation);
    if (!generation.equals(command.expectedGeneration)) {
      throw new StaleAgentGenerationError(command.agentId.value);
    }
    const keys: string[] = [command.sessionKey.value];
    if (command.endDefaultSession && command.sessionKey.value !== DEFAULT_SESSION_KEY) {
      keys.push(DEFAULT_SESSION_KEY);
    }
    let ended: number = 0;
    const statement: Statement<unknown, [string, SessionEndReason, string, number, string]> =
      database.query(`
        UPDATE agent_sessions SET ended_at = ?, end_reason = ?
        WHERE agent_id = ? AND generation = ? AND session_key = ? AND ended_at IS NULL
      `);
    for (const key of keys) {
      ended += statement.run(
        now.toISOString(),
        command.endReason,
        command.agentId.value,
        generation.value,
        key,
      ).changes;
    }
    database
      .query<unknown, [string, string]>("UPDATE agents SET last_seen_at = ? WHERE agent_id = ?")
      .run(now.toISOString(), command.agentId.value);
    database.exec("COMMIT");
    return { ended, generation };
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
export function closeSqliteAgent(
  database: Database,
  command: CloseAgentCommand,
  now: Instant,
): CloseAgentResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row: StoredAgentRow | null = storedAgent(database, command.agentId);
    if (row === null) throw new UnknownAgentError(command.agentId.value);
    const generation: AgentGeneration = AgentGeneration.parse(row.generation);
    if (!generation.equals(command.expectedGeneration)) {
      throw new StaleAgentGenerationError(command.agentId.value);
    }
    const alreadyClosed: boolean = row.closed_at !== null;
    let endedSessions: number = 0;
    if (!alreadyClosed) {
      database
        .query<unknown, [string, string, string, string]>(`
          UPDATE agents SET closed_at = ?, close_reason = ?, last_seen_at = ? WHERE agent_id = ?
        `)
        .run(now.toISOString(), command.closeReason, now.toISOString(), command.agentId.value);
      endedSessions = database
        .query<unknown, [string, string, number]>(`
          UPDATE agent_sessions SET ended_at = ?, end_reason = 'closed'
          WHERE agent_id = ? AND generation = ? AND ended_at IS NULL
        `)
        .run(now.toISOString(), command.agentId.value, generation.value).changes;
    }
    const unreadRow: unknown = database
      .query<unknown, [string, number, string]>(`
        SELECT COUNT(*) AS count FROM messages
        WHERE recipient_id = ? AND recipient_generation = ? AND read_at IS NULL AND expires_at > ?
      `)
      .get(command.agentId.value, generation.value, now.toISOString());
    const unreadValue: unknown =
      unreadRow === null || typeof unreadRow !== "object" ? 0 : Reflect.get(unreadRow, "count");
    const unreadCount: number =
      typeof unreadValue === "number" || typeof unreadValue === "bigint" ? Number(unreadValue) : 0;
    const agent: Agent = sqliteAgent(database, command.agentId, now);
    const result: CloseAgentResult = {
      agent,
      alreadyClosed,
      endedSessions,
      unreadCount,
    };
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
