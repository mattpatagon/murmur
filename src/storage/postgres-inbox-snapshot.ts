import type { TransactionSql } from "postgres";
import { z } from "zod";

import { StorageCorruptionError } from "../domain/errors.js";
import type { GetMessagesQuery } from "../domain/models.js";
import { type Instant, Sequence, type TenantId } from "../domain/value-objects.js";
import {
  INBOX_PAGE_ROW_OVERHEAD_BYTES,
  MAX_INBOX_PAGE_BYTES,
  PLAINTEXT_PAGE_CONTENT_MULTIPLIER,
  parsePostgresInboxPage,
  requirePostgresInboxPageBudget,
} from "./inbox-page-budget.js";
import {
  InboxVersionRowSchema,
  type MessageRow,
  MessageRowSchema,
} from "./postgres-message-rows.js";

type InboxSnapshot = {
  readonly estimatedBytes: number;
  readonly rows: MessageRow[];
  readonly inboxVersion: Sequence;
};

const SnapshotRowsSchema: z.ZodType<Record<string, unknown>[]> = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(500);
const EmptyMessageSchema: z.ZodType<{ readonly [Field in keyof MessageRow]: null }> =
  z.strictObject({
    branch_name: z.null(),
    broadcast_id: z.null(),
    client_name: z.null(),
    content: z.null(),
    created_at: z.null(),
    expires_at: z.null(),
    message_id: z.null(),
    message_kind: z.null(),
    orchestrator_policy_id: z.null(),
    read_at: z.null(),
    recipient_id: z.null(),
    recipient_generation: z.null(),
    repository_name: z.null(),
    sender_id: z.null(),
    sender_generation: z.null(),
    sender_authority: z.null(),
    sequence: z.null(),
    thread_id: z.null(),
  });

function parseSnapshot(input: unknown, limit: number): InboxSnapshot {
  // Capacity errors keep the existing actionable contract, including payload-free sentinels.
  const estimatedBytes: number = requirePostgresInboxPageBudget(input);
  try {
    const rawRows: Record<string, unknown>[] = SnapshotRowsSchema.parse(input);
    const first: Record<string, unknown> | undefined = rawRows[0];
    if (first === undefined) throw new Error("Missing inbox snapshot metadata");
    const inboxVersion: Sequence = Sequence.parse(
      InboxVersionRowSchema.parse({ version: first["inbox_version"] }).version,
    );
    const payloadRows: Record<string, unknown>[] = rawRows.map(
      (row: Record<string, unknown>): Record<string, unknown> => {
        const version: number = InboxVersionRowSchema.parse({
          version: row["inbox_version"],
        }).version;
        if (version !== inboxVersion.value) throw new Error("Inconsistent inbox snapshot versions");
        const { inbox_version: _version, ...payload }: Record<string, unknown> = row;
        return payload;
      },
    );
    if (estimatedBytes === 0) {
      if (payloadRows.length !== 1) throw new Error("Invalid empty inbox snapshot cardinality");
      const empty: Record<string, unknown> | undefined = payloadRows[0];
      if (empty === undefined) throw new Error("Missing empty inbox snapshot");
      const { estimated_page_bytes: _bytes, ...payload }: Record<string, unknown> = empty;
      // A null stable ID alone cannot authorize silently dropping other returned payload fields.
      EmptyMessageSchema.parse(payload);
      payloadRows.length = 0;
    }
    const parsed: { readonly estimatedBytes: number; readonly rows: MessageRow[] } =
      parsePostgresInboxPage(payloadRows, MessageRowSchema, { kind: "plaintext", limit });
    if (parsed.rows.some((row: MessageRow): boolean => row.sequence > inboxVersion.value)) {
      throw new Error("Inbox snapshot version precedes its payload");
    }
    return { ...parsed, inboxVersion };
  } catch (error: unknown) {
    if (error instanceof StorageCorruptionError) throw error;
    throw new StorageCorruptionError("inbox snapshot metadata", error);
  }
}

export async function getPostgresInboxSnapshot(
  transaction: TransactionSql,
  tenantId: TenantId,
  query: GetMessagesQuery,
  now: Instant,
  generation: number,
): Promise<InboxSnapshot> {
  const timestamp: string = now.toISOString();
  const threadId: string | null = query.threadId === null ? null : query.threadId.value;
  const raw: unknown = await transaction`
    WITH candidates AS MATERIALIZED (
      SELECT tenant_sequence,
        ${PLAINTEXT_PAGE_CONTENT_MULTIPLIER}::bigint * octet_length(content)
          + ${INBOX_PAGE_ROW_OVERHEAD_BYTES}::bigint AS estimated_bytes
      FROM murmur.messages
      WHERE tenant_id = ${tenantId.value}::uuid
        AND recipient_id = ${query.agentId.value}
        AND recipient_generation = ${generation}
        AND tenant_sequence > ${query.afterSequence.value}
        AND expires_at > ${timestamp}::timestamptz
        AND (${query.unreadOnly} = false OR read_at IS NULL)
        AND (${threadId}::text IS NULL OR thread_id = ${threadId})
      ORDER BY tenant_sequence ASC
      LIMIT ${query.limit}
    ), budget AS (
      SELECT COALESCE(SUM(estimated_bytes), 0)::bigint AS estimated_page_bytes FROM candidates
    ), high_water AS MATERIALIZED (
      SELECT COALESCE(MAX(active.tenant_sequence), 0)::bigint AS version
      FROM (
        SELECT tenant_sequence FROM murmur.messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${query.agentId.value}
          AND recipient_generation = ${generation}
          AND expires_at > ${timestamp}::timestamptz
        UNION ALL
        SELECT tenant_sequence FROM murmur.e2ee_messages
        WHERE tenant_id = ${tenantId.value}::uuid
          AND recipient_id = ${query.agentId.value}
          AND recipient_generation = ${generation}
          AND expires_at > ${timestamp}::timestamptz
      ) AS active
    )
    SELECT budget.estimated_page_bytes, high_water.version AS inbox_version,
      message.tenant_sequence AS sequence, message.message_id::text AS message_id,
      message.broadcast_id::text AS broadcast_id, message.thread_id, message.sender_id,
      message.recipient_id, message.sender_generation, message.recipient_generation,
      message.content, message.sender_authority, message.message_kind,
      message.orchestrator_policy_id::text AS orchestrator_policy_id,
      message.repository_name, message.branch_name, message.client_name,
      to_char(message.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(message.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      CASE WHEN message.read_at IS NULL THEN NULL
        ELSE to_char(message.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS read_at
    FROM budget CROSS JOIN high_water
    LEFT JOIN candidates ON budget.estimated_page_bytes <= ${MAX_INBOX_PAGE_BYTES}
    LEFT JOIN murmur.messages AS message
      ON message.tenant_id = ${tenantId.value}::uuid
      AND message.tenant_sequence = candidates.tenant_sequence
    ORDER BY message.tenant_sequence ASC
  `;
  return parseSnapshot(raw, query.limit);
}
