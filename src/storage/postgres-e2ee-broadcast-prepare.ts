import { randomUUID } from "node:crypto";

import type { Fragment, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { IdempotencyConflictError } from "../domain/errors.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import type { Agent } from "../domain/models.js";
import { AgentId, type Instant, type TenantId } from "../domain/value-objects.js";
import {
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastInputSchema,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
} from "../e2ee/wire-tools.js";
import type { E2eeWriteAuthorization } from "./e2ee-message-store.js";
import { renewPostgresSessionInTransaction } from "./postgres-agent-lifecycle-store.js";
import { claimPostgresEncryptionPrekeyInTransaction } from "./postgres-e2ee-keys.js";
import {
  type PostgresE2eeBroadcastRow,
  PostgresE2eeBroadcastRowSchema,
} from "./postgres-e2ee-rows.js";
import { requirePostgresE2eeWriteState } from "./postgres-e2ee-state.js";
import { updatePostgresE2eeUsage } from "./postgres-e2ee-usage.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

const MAX_BROADCAST_RECIPIENTS: number = 100;
const PENDING_BROADCAST_MINUTES: number = 5;

type RecipientRow = { readonly agent_id: string; readonly generation: number };
const RecipientRowSchema: z.ZodType<RecipientRow> = z.strictObject({
  agent_id: z.string(),
  generation: z
    .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
    .transform((value: bigint | number | string): number => Number(value)),
});

function normalizedInput(input: PrepareEncryptedBroadcastInput): PrepareEncryptedBroadcastInput {
  return {
    audience: input.audience,
    context: input.context,
    ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key }),
    sender_id: input.sender_id,
    ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
  };
}

async function candidateRecipients(
  transaction: TransactionSql,
  tenantId: TenantId,
  input: PrepareEncryptedBroadcastInput,
  now: Instant,
  lockRows: boolean,
): Promise<readonly RecipientRow[]> {
  const repository: string | null = input.audience.repository ?? null;
  const machine: string | null = input.audience.machine ?? null;
  const locking: Fragment = lockRows ? transaction`FOR SHARE OF agent` : transaction``;
  const raw: unknown = await transaction`
    SELECT agent.agent_id, agent.generation
    FROM murmur.agents AS agent
    WHERE agent.tenant_id = ${tenantId.value}::uuid
      AND agent.agent_id <> ${input.sender_id}
      AND agent.closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM murmur.agent_sessions AS session
        WHERE session.tenant_id = agent.tenant_id
          AND session.agent_id = agent.agent_id
          AND session.generation = agent.generation
          AND session.ended_at IS NULL
          AND session.lease_expires_at > ${now.toISOString()}::timestamptz
      )
      AND (${repository}::text IS NULL OR agent.metadata->>'repository' = ${repository})
      AND (${machine}::text IS NULL OR agent.metadata->>'machine' = ${machine})
    ORDER BY agent.agent_id ASC
    LIMIT ${MAX_BROADCAST_RECIPIENTS + 1}
    ${locking}
  `;
  const recipients: RecipientRow[] = z.array(RecipientRowSchema).parse(raw);
  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`Broadcasts are limited to ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  return recipients;
}

async function claimsForBroadcast(
  transaction: TransactionSql,
  tenantId: TenantId,
  broadcastId: string,
): Promise<ClaimEncryptionPrekeyOutput[]> {
  const raw: unknown = await transaction`
    SELECT claim_json::text AS claim_json
    FROM murmur.e2ee_claims
    WHERE tenant_id = ${tenantId.value}::uuid AND broadcast_id = ${broadcastId}::uuid
    ORDER BY recipient_id ASC
  `;
  const rows: { readonly claim_json: string }[] = z
    .array(z.strictObject({ claim_json: z.string() }))
    .parse(raw);
  return rows.map(
    (row: { readonly claim_json: string }): ClaimEncryptionPrekeyOutput =>
      ClaimEncryptionPrekeyOutputSchema.parse(JSON.parse(row.claim_json)),
  );
}

async function preparedOutput(
  transaction: TransactionSql,
  tenantId: TenantId,
  row: PostgresE2eeBroadcastRow,
  duplicate: boolean,
): Promise<PrepareEncryptedBroadcastOutput> {
  return PrepareEncryptedBroadcastOutputSchema.parse({
    broadcast_id: row.broadcast_id,
    claims: await claimsForBroadcast(transaction, tenantId, row.broadcast_id),
    duplicate,
    expires_at: row.expires_at,
    recipient_count: row.recipient_count,
    thread_id: row.thread_id,
  });
}

async function existingBroadcast(
  transaction: TransactionSql,
  tenantId: TenantId,
  input: PrepareEncryptedBroadcastInput,
  authorization: E2eeWriteAuthorization,
): Promise<PostgresE2eeBroadcastRow | null> {
  if (input.idempotency_key === undefined) return null;
  const raw: unknown = await transaction`
    SELECT broadcast_id::text AS broadcast_id,
      CASE WHEN committed_at IS NULL THEN NULL ELSE
        to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS committed_at,
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      recipient_count, request_json::text AS request_json, sender_authority,
      sender_generation, sender_id, state, thread_id
    FROM murmur.e2ee_broadcasts
    WHERE tenant_id = ${tenantId.value}::uuid
      AND sender_id = ${input.sender_id} AND idempotency_key = ${input.idempotency_key}
    FOR UPDATE
  `;
  const rows: PostgresE2eeBroadcastRow[] = z.array(PostgresE2eeBroadcastRowSchema).parse(raw);
  const row: PostgresE2eeBroadcastRow | undefined = rows[0];
  if (row === undefined) return null;
  const stored: PrepareEncryptedBroadcastInput = PrepareEncryptedBroadcastInputSchema.parse(
    JSON.parse(row.request_json),
  );
  if (
    JSON.stringify(stored) !== JSON.stringify(normalizedInput(input)) ||
    row.sender_authority !== authorization.provenance.sender_authority
  ) {
    throw new IdempotencyConflictError(input.idempotency_key);
  }
  return row;
}

function sameRecipients(left: readonly RecipientRow[], right: readonly RecipientRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function preparePostgresEncryptedBroadcast(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  authorization: E2eeWriteAuthorization,
  now: Instant,
): Promise<PrepareEncryptedBroadcastOutput> {
  const input: PrepareEncryptedBroadcastInput =
    PrepareEncryptedBroadcastInputSchema.parse(inputValue);
  if (
    (authorization.boundSenderId !== null && authorization.boundSenderId !== input.sender_id) ||
    authorization.provenance.message_kind !== "message" ||
    authorization.provenance.orchestrator_policy_id !== null
  ) {
    throw new Error("Encrypted broadcast authority is unavailable for this credential");
  }
  return await database.begin(
    async (transaction: TransactionSql): Promise<PrepareEncryptedBroadcastOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requirePostgresE2eeWriteState(transaction, tenantId, ["enforced"]);
      const initialPrior: PostgresE2eeBroadcastRow | null = await existingBroadcast(
        transaction,
        tenantId,
        input,
        authorization,
      );
      if (initialPrior !== null) {
        if (initialPrior.state === "cancelled")
          throw new Error("Encrypted broadcast was cancelled");
        if (initialPrior.state === "pending" && initialPrior.expires_at <= now.toISOString()) {
          throw new Error("Encrypted broadcast is unavailable or expired");
        }
        return await preparedOutput(transaction, tenantId, initialPrior, true);
      }
      const initialRecipients: readonly RecipientRow[] = await candidateRecipients(
        transaction,
        tenantId,
        input,
        now,
        false,
      );
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        input.sender_id,
        ...initialRecipients.map((recipient: RecipientRow): string => recipient.agent_id),
      ]);
      const concurrentPrior: PostgresE2eeBroadcastRow | null = await existingBroadcast(
        transaction,
        tenantId,
        input,
        authorization,
      );
      if (concurrentPrior !== null) {
        if (concurrentPrior.state === "cancelled")
          throw new Error("Encrypted broadcast was cancelled");
        return await preparedOutput(transaction, tenantId, concurrentPrior, true);
      }
      const recipients: readonly RecipientRow[] = await candidateRecipients(
        transaction,
        tenantId,
        input,
        now,
        true,
      );
      if (!sameRecipients(initialRecipients, recipients)) {
        throw new Error("Encrypted broadcast audience changed concurrently; retry preparation");
      }
      const sender: Agent = await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        AgentId.parse(input.sender_id),
        input.session_key === undefined
          ? SessionKey.default()
          : SessionKey.parse(input.session_key),
        now,
        true,
      );
      const broadcastId: string = randomUUID();
      const threadId: string = input.thread_id ?? randomUUID();
      const expiresAt: string = now.addMinutes(PENDING_BROADCAST_MINUTES).toISOString();
      await transaction`
        INSERT INTO murmur.e2ee_broadcasts(
          tenant_id, broadcast_id, sender_id, sender_generation, sender_authority,
          thread_id, audience_repository_name, audience_machine_name, idempotency_key,
          request_json, recipient_count, state, created_at, expires_at
        ) VALUES (
          ${tenantId.value}::uuid, ${broadcastId}::uuid, ${input.sender_id},
          ${sender.generation.value}, ${authorization.provenance.sender_authority}, ${threadId},
          ${input.audience.repository ?? null}, ${input.audience.machine ?? null},
          ${input.idempotency_key ?? null}, ${database.json(normalizedInput(input))},
          ${recipients.length}, 'pending', ${now.toISOString()}::timestamptz,
          ${expiresAt}::timestamptz
        )
      `;
      const claims: ClaimEncryptionPrekeyOutput[] = [];
      for (const recipient of recipients) {
        const claimInput: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse({
          context: input.context,
          recipient_id: recipient.agent_id,
          sender_id: input.sender_id,
          ...(input.session_key === undefined ? {} : { session_key: input.session_key }),
        });
        const claim: ClaimEncryptionPrekeyOutput = await claimPostgresEncryptionPrekeyInTransaction(
          database,
          transaction,
          tenantId,
          claimInput,
          authorization,
          now,
          broadcastId,
          true,
        );
        claims.push(claim);
        await transaction`
          INSERT INTO murmur.e2ee_broadcast_deliveries(
            tenant_id, broadcast_id, recipient_id, recipient_generation, claim_id
          ) VALUES (
            ${tenantId.value}::uuid, ${broadcastId}::uuid, ${recipient.agent_id},
            ${recipient.generation}, ${claim.claim_id}::uuid
          )
        `;
      }
      await updatePostgresE2eeUsage(transaction, tenantId, {
        claimCount: 0,
        pendingBroadcastCount: 1,
        pendingCiphertextBytes: 0,
        pendingDeliveryCount: recipients.length,
        publicPrekeyCount: 0,
        retainedCiphertextBytes: 0,
        retainedMessageCount: 0,
      });
      return PrepareEncryptedBroadcastOutputSchema.parse({
        broadcast_id: broadcastId,
        claims,
        duplicate: false,
        expires_at: expiresAt,
        recipient_count: recipients.length,
        thread_id: threadId,
      });
    },
  );
}
