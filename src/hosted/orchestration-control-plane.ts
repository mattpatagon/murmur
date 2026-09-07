import { randomUUID } from "node:crypto";

import type { Fragment, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { RETENTION_DAYS } from "../domain/contracts.js";
import { AgentAuthorityError, IdempotencyConflictError } from "../domain/errors.js";
import type { Message } from "../domain/models.js";
import { type OrchestratorPolicyId, PersonalId } from "../domain/orchestration.js";
import { type AgentId, MachineName, RepositoryName, ThreadId } from "../domain/value-objects.js";
import {
  firstRow,
  type MessageRow,
  MessageRowSchema,
  mapMessageRow,
} from "../storage/postgres-message-rows.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "../storage/postgres-message-transactions.js";
import type {
  AskOrchestratorCommand,
  EffectiveOrchestrator,
  OrchestrationRequestResult,
  OrchestratorPolicy,
  OrchestratorScope,
  TenantPrincipal,
} from "./control-plane-contracts.js";
import {
  mapOrchestratorPolicy,
  OrchestratorPolicyRowSchema,
  toEffectiveOrchestrator,
} from "./orchestration-rows.js";

function requirePersonalId(principal: TenantPrincipal): PersonalId {
  if (principal.personalId === undefined || principal.personalId === null) {
    throw new Error("This credential has no personal identity binding");
  }
  return principal.personalId;
}

function repositoryName(principal: TenantPrincipal): RepositoryName | null {
  return principal.repositoryName === undefined ? null : principal.repositoryName;
}

function machineName(principal: TenantPrincipal): MachineName | null {
  return principal.machineName === undefined ? null : principal.machineName;
}

function scopeOwnerId(principal: TenantPrincipal, scope: OrchestratorScope): string {
  if (scope.kind === "organization") return principal.tenantId.value;
  if (scope.personalId === null) throw new Error("A personal scope requires a personal identity");
  return scope.personalId.value;
}

async function ensurePersonalScopeExists(
  transaction: TransactionSql,
  principal: TenantPrincipal,
  scope: OrchestratorScope,
): Promise<void> {
  if (scope.kind !== "personal" || scope.personalId === null) return;
  const rawRows: unknown = await transaction`
    SELECT token_id::text AS token_id
    FROM murmur.access_tokens
    WHERE tenant_id = ${principal.tenantId.value}::uuid
      AND personal_id = ${scope.personalId.value}::uuid
    LIMIT 1
  `;
  const rows: { readonly token_id: string }[] = z
    .array(z.strictObject({ token_id: z.string().uuid() }))
    .parse(rawRows);
  if (rows.length === 0) throw new Error("The personal identity is unavailable in this tenant");
}

function parsePolicies(rawRows: unknown): OrchestratorPolicy[] {
  return z.array(OrchestratorPolicyRowSchema).parse(rawRows).map(mapOrchestratorPolicy);
}

type StoredPolicyScopeRow = {
  readonly machine_name: string;
  readonly policy_id: string;
  readonly repository_name: string;
  readonly scope_kind: "organization" | "personal";
  readonly scope_owner_id: string;
};

const StoredPolicyScopeRowSchema: z.ZodType<StoredPolicyScopeRow> = z.strictObject({
  machine_name: z.string(),
  policy_id: z.string().uuid(),
  repository_name: z.string(),
  scope_kind: z.enum(["organization", "personal"]),
  scope_owner_id: z.string().uuid(),
});

export async function setPostgresOrchestratorPolicy(
  database: Sql,
  principal: TenantPrincipal,
  scope: OrchestratorScope,
  orchestratorKeyId: string,
  instructions: string,
): Promise<OrchestratorPolicy> {
  return await database.begin(async (transaction: TransactionSql): Promise<OrchestratorPolicy> => {
    await setPostgresTenantContext(transaction, principal.tenantId);
    await ensurePersonalScopeExists(transaction, principal, scope);
    const ownerId: string = scopeOwnerId(principal, scope);
    const repository: string = scope.repositoryName === null ? "" : scope.repositoryName.value;
    const machine: string = scope.machineName === null ? "" : scope.machineName.value;
    const rawRows: unknown = await transaction`
        INSERT INTO murmur.orchestrator_policies(
          tenant_id, scope_kind, scope_owner_id, repository_name,
          machine_name, orchestrator_token_id, instructions, enabled,
          created_by_token_id, updated_by_token_id
        )
        SELECT
          ${principal.tenantId.value}::uuid, ${scope.kind}, ${ownerId}::uuid, ${repository}, ${machine},
          token.token_id, ${instructions}, true,
          ${principal.tokenId}::uuid, ${principal.tokenId}::uuid
        FROM murmur.access_tokens AS token
        WHERE token.tenant_id = ${principal.tenantId.value}::uuid
          AND token.key_id = ${orchestratorKeyId}
          AND token.token_role = 'orchestrator'
          AND token.revoked_at IS NULL
          AND (token.expires_at IS NULL OR token.expires_at > pg_catalog.statement_timestamp())
        ON CONFLICT(tenant_id, scope_kind, scope_owner_id, repository_name, machine_name) DO UPDATE SET
          orchestrator_token_id = excluded.orchestrator_token_id,
          instructions = excluded.instructions,
          enabled = true,
          updated_by_token_id = excluded.updated_by_token_id,
          updated_at = pg_catalog.statement_timestamp()
        RETURNING
          policy_id::text AS policy_id, scope_kind, scope_owner_id::text AS scope_owner_id,
          repository_name, machine_name, orchestrator_token_id::text AS orchestrator_token_id,
          (
            SELECT token.orchestrator_agent_id
            FROM murmur.access_tokens AS token
            WHERE token.tenant_id = murmur.orchestrator_policies.tenant_id
              AND token.token_id = murmur.orchestrator_policies.orchestrator_token_id
          ) AS orchestrator_agent_id,
          instructions, enabled,
          created_by_token_id::text AS created_by_token_id,
          updated_by_token_id::text AS updated_by_token_id,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      `;
    const policies: OrchestratorPolicy[] = parsePolicies(rawRows);
    const policy: OrchestratorPolicy | undefined = policies[0];
    if (policy === undefined) throw new Error("The selected orchestrator credential is inactive");
    return policy;
  });
}

export async function clearPostgresOrchestratorPolicy(
  database: Sql,
  principal: TenantPrincipal,
  scope: OrchestratorScope,
): Promise<boolean> {
  return await database.begin(async (transaction: TransactionSql): Promise<boolean> => {
    await setPostgresTenantContext(transaction, principal.tenantId);
    const ownerId: string = scopeOwnerId(principal, scope);
    const repository: string = scope.repositoryName === null ? "" : scope.repositoryName.value;
    const machine: string = scope.machineName === null ? "" : scope.machineName.value;
    const rawRows: unknown = await transaction`
      UPDATE murmur.orchestrator_policies
      SET enabled = false,
          updated_by_token_id = ${principal.tokenId}::uuid,
          updated_at = pg_catalog.statement_timestamp()
      WHERE tenant_id = ${principal.tenantId.value}::uuid
        AND scope_kind = ${scope.kind}
        AND scope_owner_id = ${ownerId}::uuid
        AND repository_name = ${repository}
        AND machine_name = ${machine}
        AND enabled
      RETURNING policy_id::text AS policy_id
    `;
    return z.array(z.strictObject({ policy_id: z.string().uuid() })).parse(rawRows).length > 0;
  });
}

async function resolveInTransaction(
  transaction: TransactionSql,
  principal: TenantPrincipal,
  lockAuthority: boolean,
): Promise<OrchestratorPolicy | null> {
  const personalId: PersonalId = requirePersonalId(principal);
  const repository: RepositoryName | null = repositoryName(principal);
  const repositoryValue: string | null = repository === null ? null : repository.value;
  const machine: MachineName | null = machineName(principal);
  const machineValue: string | null = machine === null ? null : machine.value;
  const lockingClause: Fragment = lockAuthority
    ? transaction`FOR SHARE OF policy, token`
    : transaction``;
  const rawRows: unknown = await transaction`
    SELECT
      policy.policy_id::text AS policy_id, policy.scope_kind,
      policy.scope_owner_id::text AS scope_owner_id, policy.repository_name, policy.machine_name,
      policy.orchestrator_token_id::text AS orchestrator_token_id,
      token.orchestrator_agent_id, policy.instructions, policy.enabled,
      policy.created_by_token_id::text AS created_by_token_id,
      policy.updated_by_token_id::text AS updated_by_token_id,
      to_char(policy.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(policy.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM murmur.orchestrator_policies AS policy
    JOIN murmur.access_tokens AS token
      ON token.tenant_id = policy.tenant_id
      AND token.token_id = policy.orchestrator_token_id
    WHERE policy.tenant_id = ${principal.tenantId.value}::uuid
      AND policy.enabled
      AND token.token_role = 'orchestrator'
      AND token.revoked_at IS NULL
      AND (token.expires_at IS NULL OR token.expires_at > pg_catalog.statement_timestamp())
      AND (
        (policy.scope_kind = 'personal' AND policy.scope_owner_id = ${personalId.value}::uuid)
        OR (policy.scope_kind = 'organization' AND policy.scope_owner_id = ${principal.tenantId.value}::uuid)
      )
      AND (
        policy.repository_name = ''
        OR (${repositoryValue}::text IS NOT NULL AND policy.repository_name = ${repositoryValue})
      )
      AND (
        policy.machine_name = ''
        OR (${machineValue}::text IS NOT NULL AND policy.machine_name = ${machineValue})
      )
    ORDER BY
      CASE
        WHEN policy.repository_name <> '' AND policy.machine_name <> '' THEN 1
        WHEN policy.repository_name <> '' OR policy.machine_name <> '' THEN 2
        ELSE 3
      END,
      CASE WHEN policy.scope_kind = 'personal' THEN 1 ELSE 2 END,
      CASE WHEN policy.repository_name <> '' THEN 1 ELSE 2 END,
      policy.policy_id
    LIMIT 1
    ${lockingClause}
  `;
  const policies: OrchestratorPolicy[] = parsePolicies(rawRows);
  return policies[0] ?? null;
}

export async function resolvePostgresOrchestrator(
  database: Sql,
  principal: TenantPrincipal,
): Promise<EffectiveOrchestrator | null> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<EffectiveOrchestrator | null> => {
      await setPostgresTenantContext(transaction, principal.tenantId);
      const policy: OrchestratorPolicy | null = await resolveInTransaction(
        transaction,
        principal,
        false,
      );
      return policy === null ? null : toEffectiveOrchestrator(policy);
    },
  );
}

async function existingRequest(
  transaction: TransactionSql,
  principal: TenantPrincipal,
  command: AskOrchestratorCommand,
): Promise<{ readonly message: Message; readonly policy: EffectiveOrchestrator } | null> {
  const rawRows: unknown = await transaction`
    SELECT
      tenant_sequence AS sequence, message_id::text AS message_id,
      broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
      sender_generation, recipient_generation,
      content, sender_authority, message_kind,
      orchestrator_policy_id::text AS orchestrator_policy_id,
      repository_name, branch_name, client_name,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      CASE WHEN read_at IS NULL THEN NULL
        ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS read_at
    FROM murmur.messages
    WHERE tenant_id = ${principal.tenantId.value}::uuid
      AND sender_id = ${command.senderId.value}
      AND idempotency_key = ${command.idempotencyKey.value}
  `;
  const rows: MessageRow[] = z.array(MessageRowSchema).parse(rawRows);
  const row: MessageRow | undefined = rows[0];
  if (row === undefined) return null;
  const message: Message = mapMessageRow(row);
  const sameThread: boolean =
    command.threadId === null || message.threadId.value === command.threadId.value;
  const matches: boolean =
    message.messageKind === "orchestration_request" &&
    message.senderAuthority === "peer" &&
    message.content.value === command.content.value &&
    message.repositoryName !== null &&
    message.repositoryName.equals(command.repositoryName) &&
    message.branchName !== null &&
    message.branchName.equals(command.branchName) &&
    message.client !== null &&
    message.client.equals(command.client) &&
    sameThread;
  if (!matches || message.orchestratorPolicyId === null) {
    throw new IdempotencyConflictError(command.idempotencyKey.value);
  }
  const rawPolicyRows: unknown = await transaction`
    SELECT
      policy.policy_id::text AS policy_id,
      policy.scope_kind,
      policy.scope_owner_id::text AS scope_owner_id,
      policy.repository_name,
      policy.machine_name
    FROM murmur.orchestrator_policies AS policy
    WHERE policy.tenant_id = ${principal.tenantId.value}::uuid
      AND policy.policy_id = ${message.orchestratorPolicyId.value}::uuid
  `;
  const rowPolicy: StoredPolicyScopeRow = firstRow(
    z.array(StoredPolicyScopeRowSchema).parse(rawPolicyRows),
    "idempotent orchestrator policy",
  );
  const policy: EffectiveOrchestrator = {
    orchestratorAgentId: message.recipientId,
    policyId: message.orchestratorPolicyId,
    scope: {
      kind: rowPolicy.scope_kind,
      machineName: rowPolicy.machine_name === "" ? null : MachineName.parse(rowPolicy.machine_name),
      personalId:
        rowPolicy.scope_kind === "personal" ? PersonalId.parse(rowPolicy.scope_owner_id) : null,
      repositoryName:
        rowPolicy.repository_name === null || rowPolicy.repository_name === ""
          ? null
          : RepositoryName.parse(rowPolicy.repository_name),
    },
  };
  return { message, policy };
}

export async function askPostgresOrchestrator(
  database: Sql,
  principal: TenantPrincipal,
  command: AskOrchestratorCommand,
): Promise<OrchestrationRequestResult> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<OrchestrationRequestResult> => {
      await setPostgresTenantContext(transaction, principal.tenantId);
      const duplicate: {
        readonly message: Message;
        readonly policy: EffectiveOrchestrator;
      } | null = await existingRequest(transaction, principal, command);
      if (duplicate !== null) {
        return {
          duplicate: true,
          message: duplicate.message,
          policy: duplicate.policy,
        };
      }
      const policy: OrchestratorPolicy | null = await resolveInTransaction(
        transaction,
        principal,
        true,
      );
      if (policy === null) throw new Error("No active orchestrator is configured");
      const rawSenderRows: unknown = await transaction`
        SELECT authority
        FROM murmur.agents
        WHERE tenant_id = ${principal.tenantId.value}::uuid
          AND agent_id = ${command.senderId.value}
      `;
      const senders: { readonly authority: "orchestrator" | "peer" }[] = z
        .array(z.strictObject({ authority: z.enum(["peer", "orchestrator"]) }))
        .parse(rawSenderRows);
      const sender: { readonly authority: "orchestrator" | "peer" } | undefined = senders[0];
      if (sender === undefined || sender.authority !== "peer") throw new AgentAuthorityError();
      await lockPostgresRecipientCommitOrder(database, transaction, principal.tenantId, [
        policy.orchestratorAgentId.value,
      ]);
      const messageId: string = randomUUID();
      const threadId: ThreadId = command.threadId === null ? ThreadId.generate() : command.threadId;
      const rawRows: unknown = await transaction`
        INSERT INTO murmur.messages(
          tenant_id, message_id, thread_id, sender_id, recipient_id, content,
          sender_authority, message_kind, orchestrator_policy_id,
          repository_name, branch_name, client_name, idempotency_key,
          created_at, expires_at
        )
        SELECT
          ${principal.tenantId.value}::uuid, ${messageId}::uuid, ${threadId.value},
          ${command.senderId.value}, ${policy.orchestratorAgentId.value}, ${command.content.value},
          'peer', 'orchestration_request', ${policy.policyId.value}::uuid,
          ${command.repositoryName.value}, ${command.branchName.value}, ${command.client.value},
          ${command.idempotencyKey.value}, pg_catalog.statement_timestamp(),
          pg_catalog.statement_timestamp() + (${RETENTION_DAYS} * interval '1 day')
        FROM murmur.orchestrator_policies AS selected_policy
        JOIN murmur.access_tokens AS selected_token
          ON selected_token.tenant_id = selected_policy.tenant_id
          AND selected_token.token_id = selected_policy.orchestrator_token_id
        WHERE selected_policy.tenant_id = ${principal.tenantId.value}::uuid
          AND selected_policy.policy_id = ${policy.policyId.value}::uuid
          AND selected_policy.orchestrator_token_id = ${policy.orchestratorTokenId}::uuid
          AND selected_policy.enabled
          AND selected_token.token_role = 'orchestrator'
          AND selected_token.orchestrator_agent_id = ${policy.orchestratorAgentId.value}
          AND selected_token.revoked_at IS NULL
          AND (
            selected_token.expires_at IS NULL
            OR selected_token.expires_at > pg_catalog.statement_timestamp()
          )
        ON CONFLICT(tenant_id, sender_id, idempotency_key) DO NOTHING
        RETURNING
          tenant_sequence AS sequence, message_id::text AS message_id,
          broadcast_id::text AS broadcast_id, thread_id, sender_id, recipient_id,
          sender_generation, recipient_generation,
          content, sender_authority, message_kind,
          orchestrator_policy_id::text AS orchestrator_policy_id,
          repository_name, branch_name, client_name,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          CASE WHEN read_at IS NULL THEN NULL
            ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS read_at
      `;
      const insertedRows: MessageRow[] = z.array(MessageRowSchema).parse(rawRows);
      const inserted: MessageRow | undefined = insertedRows[0];
      if (inserted !== undefined) {
        return {
          duplicate: false,
          message: mapMessageRow(inserted),
          policy: toEffectiveOrchestrator(policy),
        };
      }
      const winner: {
        readonly message: Message;
        readonly policy: EffectiveOrchestrator;
      } | null = await existingRequest(transaction, principal, command);
      if (winner === null) throw new Error("No active orchestrator is configured");
      return { duplicate: true, message: winner.message, policy: winner.policy };
    },
  );
}

export async function getPostgresDelegation(
  database: Sql,
  principal: TenantPrincipal,
  policyId: OrchestratorPolicyId,
): Promise<OrchestratorPolicy | null> {
  if (
    principal.role !== "orchestrator" ||
    principal.agentId === undefined ||
    principal.agentId === null
  ) {
    return null;
  }
  const agentId: AgentId = principal.agentId;
  const rawRows: unknown = await database.begin(
    async (transaction: TransactionSql): Promise<unknown> => {
      await setPostgresTenantContext(transaction, principal.tenantId);
      return await transaction`
        SELECT
          policy.policy_id::text AS policy_id, policy.scope_kind,
          policy.scope_owner_id::text AS scope_owner_id, policy.repository_name, policy.machine_name,
          policy.orchestrator_token_id::text AS orchestrator_token_id,
          token.orchestrator_agent_id, policy.instructions, policy.enabled,
          policy.created_by_token_id::text AS created_by_token_id,
          policy.updated_by_token_id::text AS updated_by_token_id,
          to_char(policy.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(policy.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM murmur.orchestrator_policies AS policy
        JOIN murmur.access_tokens AS token
          ON token.tenant_id = policy.tenant_id
          AND token.token_id = policy.orchestrator_token_id
        WHERE policy.tenant_id = ${principal.tenantId.value}::uuid
          AND policy.policy_id = ${policyId.value}::uuid
          AND policy.orchestrator_token_id = ${principal.tokenId}::uuid
          AND token.orchestrator_agent_id = ${agentId.value}
      `;
    },
  );
  const policies: OrchestratorPolicy[] = parsePolicies(rawRows);
  return policies[0] ?? null;
}
