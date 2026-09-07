import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { AgentAuthorityConflictError } from "../domain/errors.js";
import { PersonalId } from "../domain/orchestration.js";
import type { AgentId, Instant, MachineName, RepositoryName } from "../domain/value-objects.js";
import { setPostgresTenantContext } from "../storage/postgres-message-transactions.js";
import type {
  IssuedToken,
  Page,
  TenantPrincipal,
  TenantTokenRole,
  TokenSummary,
} from "./control-plane-contracts.js";
import {
  mapToken,
  page,
  type TokenIdRow,
  TokenIdRowSchema,
  TokenRowSchema,
} from "./control-plane-rows.js";
import { issueToken } from "./token-issuance.js";

async function personalIdForIssue(
  transaction: TransactionSql,
  principal: TenantPrincipal,
  requested: PersonalId | null,
): Promise<PersonalId> {
  if (requested === null) return PersonalId.generate();
  const rawRows: unknown = await transaction`
    SELECT token_id::text AS token_id
    FROM murmur.access_tokens
    WHERE tenant_id = ${principal.tenantId.value}::uuid
      AND personal_id = ${requested.value}::uuid
    LIMIT 1
  `;
  const rows: TokenIdRow[] = z.array(TokenIdRowSchema).parse(rawRows);
  if (rows.length === 0) throw new Error("The personal identity is unavailable in this tenant");
  return requested;
}

function attributionTokenId(principal: TenantPrincipal): string | null {
  const parsed: z.ZodSafeParseResult<string> = z.string().uuid().safeParse(principal.tokenId);
  return parsed.success ? parsed.data : null;
}

async function pruneInactiveTokens(
  transaction: TransactionSql,
  principal: TenantPrincipal,
): Promise<void> {
  await transaction`
    DELETE FROM murmur.access_tokens AS token
    WHERE token.tenant_id = ${principal.tenantId.value}::uuid
      AND (
        token.revoked_at IS NOT NULL
        OR token.expires_at <= pg_catalog.statement_timestamp()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM murmur.orchestrator_policies AS policy
        WHERE policy.tenant_id = token.tenant_id
          AND policy.orchestrator_token_id = token.token_id
      )
  `;
}

export async function createPostgresTenantToken(
  database: Sql,
  principal: TenantPrincipal,
  role: TenantTokenRole,
  name: string,
  expiresAt: Instant | null,
  requestedPersonalId: PersonalId | null,
  repositoryName: RepositoryName | null,
  machineName: MachineName | null,
): Promise<IssuedToken> {
  if (role === "orchestrator") {
    throw new Error("Use create_orchestrator_token for orchestrator credentials");
  }
  return await database.begin(async (transaction: TransactionSql): Promise<IssuedToken> => {
    await setPostgresTenantContext(transaction, principal.tenantId);
    const personalId: PersonalId = await personalIdForIssue(
      transaction,
      principal,
      requestedPersonalId,
    );
    const issued: ReturnType<typeof issueToken> = issueToken(
      principal.tenantId,
      role,
      name,
      expiresAt,
      personalId,
      repositoryName,
      null,
      machineName,
    );
    await pruneInactiveTokens(transaction, principal);
    await transaction`
      INSERT INTO murmur.access_tokens(
        token_id, tenant_id, key_id, secret_hash, token_role, name, expires_at,
        personal_id, repository_name, machine_name, created_by_token_id
      ) VALUES (
        ${issued.token.tokenId}::uuid,
        ${principal.tenantId.value}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${role},
        ${name},
        ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz,
        ${personalId.value}::uuid,
        ${repositoryName === null ? null : repositoryName.value},
        ${machineName === null ? null : machineName.value},
        ${attributionTokenId(principal)}::uuid
      )
    `;
    return issued.token;
  });
}

export async function createPostgresOrchestratorToken(
  database: Sql,
  principal: TenantPrincipal,
  agentId: AgentId,
  name: string,
  expiresAt: Instant | null,
  requestedPersonalId: PersonalId | null,
  repositoryName: RepositoryName | null,
  machineName: MachineName | null,
): Promise<IssuedToken> {
  return await database.begin(async (transaction: TransactionSql): Promise<IssuedToken> => {
    await setPostgresTenantContext(transaction, principal.tenantId);
    await transaction`
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${principal.tenantId.value}::text || ':orchestrator:' || ${agentId.value},
          0
        )
      )
    `;
    const rawAgentRows: unknown = await transaction`
      SELECT authority
      FROM murmur.agents
      WHERE tenant_id = ${principal.tenantId.value}::uuid
        AND agent_id = ${agentId.value}
    `;
    const agents: { readonly authority: "orchestrator" | "peer" }[] = z
      .array(z.strictObject({ authority: z.enum(["peer", "orchestrator"]) }))
      .parse(rawAgentRows);
    const existing: { readonly authority: "orchestrator" | "peer" } | undefined = agents[0];
    if (existing !== undefined && existing.authority !== "orchestrator") {
      throw new AgentAuthorityConflictError();
    }
    await transaction`
      UPDATE murmur.access_tokens
      SET revoked_at = pg_catalog.statement_timestamp()
      WHERE tenant_id = ${principal.tenantId.value}::uuid
        AND token_role = 'orchestrator'
        AND orchestrator_agent_id = ${agentId.value}
        AND revoked_at IS NULL
        AND expires_at <= pg_catalog.statement_timestamp()
    `;
    const rawActiveRows: unknown = await transaction`
      SELECT token_id::text AS token_id
      FROM murmur.access_tokens
      WHERE tenant_id = ${principal.tenantId.value}::uuid
        AND token_role = 'orchestrator'
        AND orchestrator_agent_id = ${agentId.value}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    if (z.array(TokenIdRowSchema).parse(rawActiveRows).length > 0) {
      throw new Error("An active orchestrator credential already reserves this agent ID");
    }
    const personalId: PersonalId = await personalIdForIssue(
      transaction,
      principal,
      requestedPersonalId,
    );
    await pruneInactiveTokens(transaction, principal);
    const issued: ReturnType<typeof issueToken> = issueToken(
      principal.tenantId,
      "orchestrator",
      name,
      expiresAt,
      personalId,
      repositoryName,
      agentId,
      machineName,
    );
    if (existing === undefined) {
      try {
        await transaction`
          INSERT INTO murmur.agents(
            tenant_id, agent_id, authority, display_name, metadata, created_at, last_seen_at
          ) VALUES (
            ${principal.tenantId.value}::uuid,
            ${agentId.value},
            'orchestrator',
            ${agentId.value},
            ${database.json({ reserved: true })},
            pg_catalog.statement_timestamp(),
            '1970-01-01T00:00:00.000Z'::timestamptz
          )
        `;
      } catch (error: unknown) {
        if (
          error instanceof postgres.PostgresError &&
          error.code === "23505" &&
          error.constraint_name === "agents_pkey"
        ) {
          throw new AgentAuthorityConflictError();
        }
        throw error;
      }
    }
    await transaction`
      INSERT INTO murmur.access_tokens(
        token_id, tenant_id, key_id, secret_hash, token_role, name, expires_at,
        personal_id, repository_name, machine_name, orchestrator_agent_id, created_by_token_id
      ) VALUES (
        ${issued.token.tokenId}::uuid,
        ${principal.tenantId.value}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        'orchestrator',
        ${name},
        ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz,
        ${personalId.value}::uuid,
        ${repositoryName === null ? null : repositoryName.value},
        ${machineName === null ? null : machineName.value},
        ${agentId.value},
        ${attributionTokenId(principal)}::uuid
      )
    `;
    return issued.token;
  });
}

export async function listPostgresTenantTokens(
  database: Sql,
  principal: TenantPrincipal,
  cursor: string | null,
  limit: number,
): Promise<Page<TokenSummary>> {
  return await database.begin(async (transaction: TransactionSql): Promise<Page<TokenSummary>> => {
    await setPostgresTenantContext(transaction, principal.tenantId);
    const rawRows: unknown = await transaction`
      SELECT
        token_id::text AS token_id, key_id, token_role, name,
        personal_id::text AS personal_id, repository_name, machine_name,
        orchestrator_agent_id AS agent_id,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        CASE WHEN expires_at IS NULL THEN NULL ELSE
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        CASE WHEN revoked_at IS NULL THEN NULL ELSE
          to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS revoked_at,
        CASE WHEN last_used_at IS NULL THEN NULL ELSE
          to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS last_used_at
      FROM murmur.access_tokens
      WHERE tenant_id = ${principal.tenantId.value}::uuid
        AND (
          ${cursor}::uuid IS NULL
          OR (created_at, token_id) < (
            SELECT cursor_token.created_at, cursor_token.token_id
            FROM murmur.access_tokens AS cursor_token
            WHERE cursor_token.tenant_id = ${principal.tenantId.value}::uuid
              AND cursor_token.token_id = ${cursor}::uuid
          )
        )
      ORDER BY created_at DESC, token_id DESC
      LIMIT ${limit + 1}
    `;
    const items: readonly TokenSummary[] = z.array(TokenRowSchema).parse(rawRows).map(mapToken);
    return page(items, limit, (item: TokenSummary): string => item.tokenId);
  });
}

export async function revokePostgresTenantToken(
  database: Sql,
  principal: TenantPrincipal,
  keyId: string,
): Promise<string | null> {
  return await database.begin(async (transaction: TransactionSql): Promise<string | null> => {
    await setPostgresTenantContext(transaction, principal.tenantId);
    const rawRows: unknown = await transaction`
      UPDATE murmur.access_tokens
      SET revoked_at = pg_catalog.statement_timestamp()
      WHERE tenant_id = ${principal.tenantId.value}::uuid
        AND key_id = ${keyId}
        AND revoked_at IS NULL
      RETURNING token_id::text AS token_id
    `;
    const row: TokenIdRow | undefined = z.array(TokenIdRowSchema).parse(rawRows)[0];
    return row === undefined ? null : row.token_id;
  });
}
