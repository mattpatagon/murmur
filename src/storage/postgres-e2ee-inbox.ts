import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import {
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
} from "../domain/contracts.js";
import { AgentClosedError } from "../domain/errors.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import type { Agent } from "../domain/models.js";
import { AgentId, type Instant, type TenantId } from "../domain/value-objects.js";
import {
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type EncryptedMessageDto,
  type GetEncryptedMessagesInput,
  GetEncryptedMessagesInputSchema,
  type GetInboxSummaryInput,
  GetInboxSummaryInputSchema,
  type GetInboxSummaryOutput,
  GetInboxSummaryOutputSchema,
} from "../e2ee/wire-tools.js";
import {
  postgresAgentInTransaction,
  renewPostgresSessionInTransaction,
} from "./postgres-agent-lifecycle-store.js";
import { postgresEncryptedMessageFromRow } from "./postgres-e2ee-messages.js";
import {
  type PostgresE2eeMessageRow,
  PostgresE2eeMessageRowSchema,
  type PostgresE2eeSummaryRow,
  PostgresE2eeSummaryRowSchema,
} from "./postgres-e2ee-rows.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

async function readingAgent(
  transaction: TransactionSql,
  tenantId: TenantId,
  agentIdValue: string,
  sessionKeyValue: string | undefined,
  now: Instant,
): Promise<Agent> {
  const agentId: AgentId = AgentId.parse(agentIdValue);
  const agent: Agent =
    sessionKeyValue === undefined
      ? await postgresAgentInTransaction(transaction, tenantId, agentId, now)
      : await renewPostgresSessionInTransaction(
          transaction,
          tenantId,
          agentId,
          SessionKey.parse(sessionKeyValue),
          now,
          false,
        );
  if (agent.state === "closed") throw new AgentClosedError(agentId.value);
  return agent;
}

async function summaryRow(
  transaction: TransactionSql,
  tenantId: TenantId,
  agent: Agent,
  now: Instant,
): Promise<PostgresE2eeSummaryRow> {
  const raw: unknown = await transaction`
    SELECT COALESCE(MAX(tenant_sequence), 0)::bigint AS version,
      MAX(tenant_sequence)::bigint AS newest_sequence,
      COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count
    FROM murmur.e2ee_messages
    WHERE tenant_id = ${tenantId.value}::uuid
      AND recipient_id = ${agent.agentId.value}
      AND recipient_generation = ${agent.generation.value}
      AND expires_at > ${now.toISOString()}::timestamptz
  `;
  const rows: PostgresE2eeSummaryRow[] = z.array(PostgresE2eeSummaryRowSchema).parse(raw);
  const row: PostgresE2eeSummaryRow | undefined = rows[0];
  if (row === undefined) throw new Error("Encrypted inbox summary is unavailable");
  return row;
}

export async function getPostgresEncryptedMessages(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  now: Instant,
): Promise<EncryptedInboxOutput> {
  const input: GetEncryptedMessagesInput = GetEncryptedMessagesInputSchema.parse(inputValue);
  return await database.begin(
    async (transaction: TransactionSql): Promise<EncryptedInboxOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      const agent: Agent = await readingAgent(
        transaction,
        tenantId,
        input.agent_id,
        input.session_key,
        now,
      );
      const threadId: string | null = input.thread_id === undefined ? null : input.thread_id;
      const raw: unknown = await transaction`
      SELECT tenant_sequence, envelope_json::text AS envelope_json,
        sender_chain_json::text AS sender_chain_json,
        CASE WHEN read_at IS NULL THEN NULL ELSE
          to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS read_at
      FROM murmur.e2ee_messages
      WHERE tenant_id = ${tenantId.value}::uuid
        AND recipient_id = ${input.agent_id}
        AND recipient_generation = ${agent.generation.value}
        AND tenant_sequence > ${input.after_sequence}
        AND expires_at > ${now.toISOString()}::timestamptz
        AND (${input.unread_only} = false OR read_at IS NULL)
        AND (${threadId}::text IS NULL OR thread_id = ${threadId})
      ORDER BY tenant_sequence ASC
      LIMIT ${input.limit}
    `;
      const rows: PostgresE2eeMessageRow[] = z.array(PostgresE2eeMessageRowSchema).parse(raw);
      const messages: EncryptedMessageDto[] = rows.map(
        (row: PostgresE2eeMessageRow): EncryptedMessageDto => postgresEncryptedMessageFromRow(row),
      );
      const summary: PostgresE2eeSummaryRow = await summaryRow(transaction, tenantId, agent, now);
      return EncryptedInboxOutputSchema.parse({
        agent_id: input.agent_id,
        inbox_version: summary.version,
        messages,
      });
    },
  );
}

export async function markPostgresEncryptedMessagesRead(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  now: Instant,
): Promise<MarkMessagesReadOutput> {
  const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(inputValue);
  return await database.begin(
    async (transaction: TransactionSql): Promise<MarkMessagesReadOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      const agent: Agent = await readingAgent(
        transaction,
        tenantId,
        input.agent_id,
        input.session_key,
        now,
      );
      if (input.message_ids.length === 0) {
        return MarkMessagesReadOutputSchema.parse({ read_at: now.toISOString(), updated: 0 });
      }
      const raw: unknown = await transaction`
        UPDATE murmur.e2ee_messages
        SET read_at = COALESCE(read_at, ${now.toISOString()}::timestamptz)
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${input.agent_id}
          AND recipient_generation = ${agent.generation.value}
          AND message_id = ANY(${database.array(input.message_ids)}::uuid[])
          AND expires_at > ${now.toISOString()}::timestamptz
        RETURNING message_id::text AS message_id
      `;
      const updated: { readonly message_id: string }[] = z
        .array(z.strictObject({ message_id: z.string().uuid() }))
        .parse(raw);
      return MarkMessagesReadOutputSchema.parse({
        read_at: now.toISOString(),
        updated: updated.length,
      });
    },
  );
}

export async function getPostgresEncryptedInboxSummary(
  database: Sql,
  tenantId: TenantId,
  inputValue: unknown,
  now: Instant,
): Promise<GetInboxSummaryOutput> {
  const input: GetInboxSummaryInput = GetInboxSummaryInputSchema.parse(inputValue);
  return await database.begin(
    async (transaction: TransactionSql): Promise<GetInboxSummaryOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      const agent: Agent = await readingAgent(
        transaction,
        tenantId,
        input.agent_id,
        input.session_key,
        now,
      );
      const summary: PostgresE2eeSummaryRow = await summaryRow(transaction, tenantId, agent, now);
      return GetInboxSummaryOutputSchema.parse({
        agent_id: input.agent_id,
        inbox_version: summary.version,
        newest_sequence: summary.newest_sequence,
        unread_count: summary.unread_count,
      });
    },
  );
}
