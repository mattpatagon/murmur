import type { Sql } from "postgres";
import { z } from "zod";

type E2eeSchemaProbe = {
  readonly broadcast_deliveries_table: string | null;
  readonly broadcasts_table: string | null;
  readonly claims_table: string | null;
  readonly forced_rls_count: number;
  readonly key_bundles_table: string | null;
  readonly messages_table: string | null;
  readonly prekeys_table: string | null;
  readonly state_table: string | null;
  readonly usage_table: string | null;
};

const DatabaseIntegerSchema: z.ZodType<number> = z
  .union([z.string().regex(/^\d+$/u), z.number().int(), z.bigint()])
  .refine((value: bigint | number | string): boolean => Number.isSafeInteger(Number(value)), {
    message: "Postgres integer exceeds JavaScript's safe integer range",
  })
  .transform((value: bigint | number | string): number => Number(value));
const E2eeSchemaProbeSchema: z.ZodType<E2eeSchemaProbe> = z.strictObject({
  broadcast_deliveries_table: z.string().nullable(),
  broadcasts_table: z.string().nullable(),
  claims_table: z.string().nullable(),
  forced_rls_count: DatabaseIntegerSchema,
  key_bundles_table: z.string().nullable(),
  messages_table: z.string().nullable(),
  prekeys_table: z.string().nullable(),
  state_table: z.string().nullable(),
  usage_table: z.string().nullable(),
});

export async function verifyPostgresE2eeSchema(database: Sql): Promise<void> {
  const raw: unknown = await database`
    SELECT
      to_regclass('murmur.e2ee_broadcast_deliveries')::text AS broadcast_deliveries_table,
      to_regclass('murmur.e2ee_broadcasts')::text AS broadcasts_table,
      to_regclass('murmur.e2ee_claims')::text AS claims_table,
      to_regclass('murmur.e2ee_key_bundles')::text AS key_bundles_table,
      to_regclass('murmur.e2ee_messages')::text AS messages_table,
      to_regclass('murmur.e2ee_prekeys')::text AS prekeys_table,
      to_regclass('murmur.tenant_e2ee_state')::text AS state_table,
      to_regclass('murmur.tenant_e2ee_usage')::text AS usage_table,
      (
        SELECT COUNT(*)::integer FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'murmur'
          AND relation.relname = ANY(ARRAY[
            'e2ee_broadcast_deliveries', 'e2ee_broadcasts', 'e2ee_claims',
            'e2ee_key_bundles', 'e2ee_messages', 'e2ee_prekeys',
            'tenant_e2ee_state', 'tenant_e2ee_usage'
          ])
          AND relation.relrowsecurity AND relation.relforcerowsecurity
      ) AS forced_rls_count
  `;
  const rows: E2eeSchemaProbe[] = z.array(E2eeSchemaProbeSchema).parse(raw);
  const row: E2eeSchemaProbe | undefined = rows[0];
  const tables: readonly (string | null)[] =
    row === undefined
      ? []
      : [
          row.broadcast_deliveries_table,
          row.broadcasts_table,
          row.claims_table,
          row.key_bundles_table,
          row.messages_table,
          row.prekeys_table,
          row.state_table,
          row.usage_table,
        ];
  if (
    row === undefined ||
    row.forced_rls_count !== 8 ||
    tables.some((table: string | null): boolean => table === null)
  ) {
    throw new Error(
      "Murmur's Postgres E2E schema is missing. Apply the committed Supabase migration first.",
    );
  }
}
