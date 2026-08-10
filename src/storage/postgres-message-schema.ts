import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";
import { firstRow, type SchemaProbeRow, SchemaProbeRowSchema } from "./postgres-message-rows.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";

export async function verifyPostgresMessageSchema(
  database: Sql,
  tenantId: TenantId,
): Promise<void> {
  const rawRows: unknown = await database.begin(
    async (transaction: TransactionSql): Promise<unknown> => {
      await setPostgresTenantContext(transaction, tenantId);
      return await transaction`
        SELECT
          to_regclass('murmur.agents')::text AS agents_table,
          to_regclass('murmur.agent_sessions')::text AS agent_sessions_table,
          to_regclass('murmur.broadcasts')::text AS broadcasts_table,
          to_regclass('murmur.messages')::text AS messages_table,
          to_regclass('murmur.notices')::text AS notices_table,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'agents'
              AND column_name = 'generation'
          ) AS agents_generation_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'agents'
              AND column_name = 'tenant_id'
          ) AS agents_tenant_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'broadcasts'
              AND column_name = 'tenant_id'
          ) AS broadcasts_tenant_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'tenant_id'
          ) AS messages_tenant_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'tenant_sequence'
          ) AS messages_tenant_sequence_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'recipient_generation'
          ) AS messages_recipient_generation_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'branch_name'
          ) AS branch_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'client_name'
          ) AS client_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'broadcast_id'
          ) AS broadcast_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'murmur' AND table_name = 'messages'
              AND column_name = 'repository_name'
          ) AS repository_column
      `;
    },
  );
  const rows: SchemaProbeRow[] = z.array(SchemaProbeRowSchema).parse(rawRows);
  const row: SchemaProbeRow = firstRow(rows, "schema probe");
  const valid: boolean =
    row.agents_table !== null &&
    row.agent_sessions_table !== null &&
    row.notices_table !== null &&
    row.agents_generation_column &&
    row.broadcasts_table !== null &&
    row.messages_table !== null &&
    row.agents_tenant_column &&
    row.broadcasts_tenant_column &&
    row.messages_tenant_column &&
    row.messages_tenant_sequence_column &&
    row.messages_recipient_generation_column &&
    row.repository_column &&
    row.branch_column &&
    row.client_column &&
    row.broadcast_column;
  if (!valid) {
    throw new Error(
      "Murmur's Postgres schema is missing. Apply the committed Supabase migration first.",
    );
  }
}
