import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { StorageCorruptionError } from "../src/domain/errors.js";
import { TenantId } from "../src/domain/value-objects.js";
import type {
  OrchestratorPolicy,
  Page,
  TenantPrincipal,
} from "../src/hosted/control-plane-contracts.js";
import { toOrchestratorPolicyDto } from "../src/hosted/orchestration-contracts.js";
import { listPostgresOrchestratorPolicies } from "../src/hosted/orchestration-policy-list.js";
import {
  MAX_POLICY_PAGE_BYTES,
  POLICY_INSTRUCTIONS_MULTIPLIER,
  POLICY_PAGE_ROW_BYTES,
} from "../src/hosted/orchestration-policy-page.js";
import {
  MaterializationByteBudget,
  MaterializationCapacityError,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import { setPostgresTenantContext } from "../src/storage/postgres-message-transactions.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";

const configured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;
const ROW_BYTES: number = 8192 * POLICY_INSTRUCTIONS_MULTIPLIER + POLICY_PAGE_ROW_BYTES;
function expectedCursor(ids: readonly string[], index: number): string {
  const id: string | undefined = ids[index];
  if (id === undefined) throw new Error("Missing expected policy cursor fixture");
  return id;
}
type CapturedRow = {
  readonly id: string;
  readonly payloadBytes: number;
  readonly keys: readonly string[];
};
type Fixture = {
  readonly admin: Sql;
  readonly app: Sql;
  readonly budget: MaterializationByteBudget;
  readonly principal: TenantPrincipal;
  readonly other: TenantPrincipal;
  readonly queries: string[];
  readonly captures: CapturedRow[];
  corruptNextPayload: boolean;
};

async function seedTenant(admin: Sql, tenantId: TenantId, count: number): Promise<TenantPrincipal> {
  const adminToken: string = randomUUID();
  const orchestratorToken: string = randomUUID();
  await admin.begin(async (transaction: TransactionSql): Promise<void> => {
    await transaction`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
      VALUES (${tenantId.value}::uuid, ${`policy-page-${tenantId.value}`}, 'Policy page fixture')`;
    for (const token of [adminToken, orchestratorToken]) {
      await transaction`INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash,
        token_role, name, personal_id, orchestrator_agent_id)
        VALUES (${token}::uuid, ${tenantId.value}::uuid, ${randomUUID().replaceAll("-", "")},
          ${randomBytes(32)}, ${token === adminToken ? "tenant_admin" : "orchestrator"},
          'Policy page fixture', ${adminToken}::uuid, ${token === adminToken ? null : "a".repeat(200)})`;
    }
    await transaction`INSERT INTO murmur.orchestrator_policies(policy_id, tenant_id, scope_kind,
      scope_owner_id, repository_name, orchestrator_token_id, instructions, enabled,
      created_by_token_id, updated_by_token_id)
      SELECT gen_random_uuid(), ${tenantId.value}::uuid,
        CASE WHEN item < 50 THEN 'organization' ELSE 'personal' END,
        CASE WHEN item < 50 THEN ${tenantId.value}::uuid
          WHEN item < 75 THEN '00000000-0000-4000-8000-000000000003'::uuid
          ELSE '00000000-0000-4000-8000-000000000004'::uuid END,
        'a/' || repeat('r', 494) || lpad((99 - item)::text, 4, '0'),
        ${orchestratorToken}::uuid, repeat(chr(1), 8192), item % 2 = 0,
        ${adminToken}::uuid, ${adminToken}::uuid
      FROM generate_series(0, ${count - 1}) AS item`;
    // Listing historically includes disabled policies and policies pointing at revoked tokens.
    await transaction`UPDATE murmur.access_tokens SET revoked_at = statement_timestamp()
      WHERE tenant_id = ${tenantId.value}::uuid AND token_id = ${orchestratorToken}::uuid`;
  });
  return { kind: "tenant", role: "tenant_admin", tenantId, tokenId: adminToken };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined)
    throw new Error("Disposable PostgreSQL URLs required");
  const admin: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const tenantId: TenantId = TenantId.generate();
  const otherId: TenantId = TenantId.generate();
  const captures: CapturedRow[] = [];
  const queries: string[] = [];
  const mutation: { corruptNextPayload: boolean } = { corruptNextPayload: false };
  const app: Sql = postgres(databaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
    debug: (_connection: number, query: string): void => {
      queries.push(query);
    },
    transform: {
      row: (row: Record<string, unknown>): Record<string, unknown> => {
        if (!("row_json" in row)) return row;
        const id: unknown = row["policy_id"];
        const payload: unknown = row["row_json"];
        if (typeof id !== "string" || (payload !== null && typeof payload !== "string"))
          throw new Error("Invalid policy transfer fixture");
        captures.push({
          id,
          payloadBytes: payload === null ? 0 : Buffer.byteLength(payload, "utf8"),
          keys: Object.keys(row).sort(),
        });
        if (mutation.corruptNextPayload && payload !== null) {
          mutation.corruptNextPayload = false;
          return { ...row, row_json: "{}" };
        }
        return row;
      },
    },
  });
  try {
    const principal: TenantPrincipal = await seedTenant(admin, tenantId, 100);
    const other: TenantPrincipal = await seedTenant(admin, otherId, 1);
    expect<unknown>(await app`SELECT current_user AS name`).toEqual([{ name: "murmur_app" }]);
    queries.length = 0;
    await run({
      admin,
      app,
      budget: new MaterializationByteBudget(MAX_POLICY_PAGE_BYTES),
      principal,
      other,
      captures,
      queries,
      get corruptNextPayload(): boolean {
        return mutation.corruptNextPayload;
      },
      set corruptNextPayload(value: boolean) {
        mutation.corruptNextPayload = value;
      },
    });
  } finally {
    try {
      await app.end({ timeout: 1 });
    } finally {
      try {
        for (const id of [tenantId, otherId]) {
          await admin.begin(async (transaction: TransactionSql): Promise<void> => {
            await transaction`DELETE FROM murmur.orchestrator_policies WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.access_tokens WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${id.value}::uuid`;
            await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${id.value}::uuid`;
          });
        }
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }
}

async function expectedIds(fixture: Fixture, principal: TenantPrincipal): Promise<string[]> {
  const rows: unknown =
    await fixture.admin`SELECT policy_id::text AS id FROM murmur.orchestrator_policies
    WHERE tenant_id = ${principal.tenantId.value}::uuid
    ORDER BY scope_kind, scope_owner_id, repository_name, policy_id`;
  return z
    .array(z.strictObject({ id: z.string().uuid() }))
    .parse(rows)
    .map((row: { readonly id: string }): string => row.id);
}

function pageIds(result: Page<OrchestratorPolicy>): string[] {
  return result.items.map((policy: OrchestratorPolicy): string => policy.policyId.value);
}

test.skipIf(!configured)(
  "PostgreSQL policy pages transfer fitting payload only and drain tenant-qualified tuple cursors",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const expected: string[] = await expectedIds(fixture, fixture.principal);
      const foreign: string | undefined = (await expectedIds(fixture, fixture.other))[0];
      if (foreign === undefined) throw new Error("Missing foreign cursor fixture");
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages: number = 0;
      do {
        fixture.captures.length = 0;
        const scope: MaterializationScope = new MaterializationScope(fixture.budget);
        const finishHandler: () => void = scope.startHandler();
        try {
          const result: Page<OrchestratorPolicy> = await withMaterializationScope(
            scope,
            async (): Promise<Page<OrchestratorPolicy>> =>
              await listPostgresOrchestratorPolicies(fixture.app, fixture.principal, cursor, 100),
          );
          expect(fixture.budget.reservedBytes).toBe(result.items.length * ROW_BYTES);
          expect(
            Buffer.byteLength(
              JSON.stringify(
                toolResult({
                  next_cursor: result.nextCursor,
                  policies: result.items.map(toOrchestratorPolicyDto),
                }),
              ),
              "utf8",
            ),
          ).toBeLessThanOrEqual(MAX_POLICY_PAGE_BYTES);
          expect(
            fixture.captures
              .filter((row: CapturedRow): boolean => row.payloadBytes > 0)
              .map((row: CapturedRow): string => row.id),
          ).toEqual(pageIds(result));
          for (const capture of fixture.captures)
            expect(capture.keys).toEqual([
              "estimated_page_bytes",
              "page_row",
              "policy_id",
              "row_json",
            ]);
          if (pages === 0) {
            expect(result.items).toHaveLength(73);
            expect(fixture.captures).toHaveLength(100);
            expect(
              fixture.captures.filter((row: CapturedRow): boolean => row.payloadBytes === 0),
            ).toHaveLength(27);
            expect(result.nextCursor).toBe(expectedCursor(expected, 72));
          }
          ids.push(...pageIds(result));
          cursor = result.nextCursor;
          scope.finishResponse();
          expect(fixture.budget.reservedBytes).toBe(result.items.length * ROW_BYTES);
        } finally {
          finishHandler();
          scope.finishResponse();
        }
        expect(fixture.budget.reservedBytes).toBe(0);
        pages += 1;
        if (pages > 3) throw new Error("Policy cursor did not advance");
      } while (cursor !== null);
      expect(pages).toBe(2);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(100);
      expect(ids).not.toContain(foreign);
      const limited: Page<OrchestratorPolicy> = await listPostgresOrchestratorPolicies(
        fixture.app,
        fixture.principal,
        null,
        7,
      );
      expect(pageIds(limited)).toEqual(expected.slice(0, 7));
      expect(limited.nextCursor).toBe(expectedCursor(expected, 6));
      const last: string | undefined = expected.at(-1);
      if (last === undefined) throw new Error("Missing final cursor fixture");
      for (const missing of [randomUUID(), foreign, last]) {
        const scope: MaterializationScope = new MaterializationScope(fixture.budget);
        try {
          expect(
            await withMaterializationScope(
              scope,
              async (): Promise<unknown> =>
                await listPostgresOrchestratorPolicies(
                  fixture.app,
                  fixture.principal,
                  missing,
                  100,
                ),
            ),
          ).toEqual({ items: [], nextCursor: null });
          expect(fixture.budget.reservedBytes).toBe(0);
        } finally {
          scope.finishResponse();
        }
      }
      expect<unknown>(
        await fixture.app.begin(async (transaction: TransactionSql): Promise<unknown> => {
          await setPostgresTenantContext(transaction, fixture.other.tenantId);
          return await transaction`SELECT policy_id FROM murmur.orchestrator_policies WHERE tenant_id = ${fixture.principal.tenantId.value}::uuid`;
        }),
      ).toEqual([]);
    });
  },
  30_000,
);

test.skipIf(!configured)(
  "PostgreSQL policy admission does no SQL when full and releases query or validation failures",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const scope: MaterializationScope = new MaterializationScope(fixture.budget);
      const held: ReturnType<MaterializationByteBudget["reserve"]> =
        fixture.budget.reserve(MAX_POLICY_PAGE_BYTES);
      try {
        fixture.queries.length = 0;
        await expect(
          withMaterializationScope(
            scope,
            async (): Promise<unknown> =>
              await listPostgresOrchestratorPolicies(fixture.app, fixture.principal, null, 100),
          ),
        ).rejects.toThrow(MaterializationCapacityError);
        expect(fixture.queries).toEqual([]);
        held.release();
        await expect(
          withMaterializationScope(
            scope,
            async (): Promise<unknown> =>
              await listPostgresOrchestratorPolicies(
                fixture.app,
                fixture.principal,
                "invalid",
                100,
              ),
          ),
        ).rejects.toMatchObject({ code: "22P02" });
        expect(fixture.budget.reservedBytes).toBe(0);
        fixture.corruptNextPayload = true;
        await expect(
          withMaterializationScope(
            scope,
            async (): Promise<unknown> =>
              await listPostgresOrchestratorPolicies(fixture.app, fixture.principal, null, 7),
          ),
        ).rejects.toThrow(StorageCorruptionError);
        expect(fixture.budget.reservedBytes).toBe(0);
        const recovered: Page<OrchestratorPolicy> = await withMaterializationScope(
          scope,
          async (): Promise<Page<OrchestratorPolicy>> =>
            await listPostgresOrchestratorPolicies(fixture.app, fixture.principal, null, 7),
        );
        expect(recovered.items).toHaveLength(7);
        expect(fixture.budget.reservedBytes).toBe(7 * ROW_BYTES);
      } finally {
        held.release();
        scope.finishResponse();
      }
      expect(fixture.budget.reservedBytes).toBe(0);
    });
  },
  30_000,
);
