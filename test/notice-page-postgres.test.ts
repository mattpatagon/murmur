import { expect, test } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import type { ListNoticesQuery, ListNoticesResult, Notice } from "../src/domain/notice-models.js";
import {
  AgentId,
  BranchName,
  Instant,
  RepositoryName,
  TenantId,
} from "../src/domain/value-objects.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import { MAX_NOTICE_PAGE_BYTES, NOTICE_PAGE_ROW_BYTES } from "../src/storage/notice-page-budget.js";
import { listPostgresNotices } from "../src/storage/postgres-notice-store.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";
import { noticePageQuery, noticePageRow } from "./support/notice-page-rows.js";

function ids(page: ListNoticesResult): string[] {
  return page.notices.map((notice: Notice): string => notice.noticeId.value);
}

async function cleanup(admin: Sql, tenants: readonly TenantId[]): Promise<void> {
  const failures: unknown[] = [];
  for (const tenant of [...tenants].reverse()) {
    try {
      await admin.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`DELETE FROM murmur.notices WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.agent_sessions WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenant.value}::uuid`;
        await transaction`DELETE FROM murmur.tenants WHERE tenant_id = ${tenant.value}::uuid`;
      });
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Notice page fixture cleanup failed");
}

test.skipIf(databaseUrl === undefined || adminDatabaseUrl === undefined)(
  "PostgreSQL notice prefixes transfer only admitted payloads and preserve tenant-qualified filters and cursors",
  async (): Promise<void> => {
    if (databaseUrl === undefined || adminDatabaseUrl === undefined)
      throw new Error("Disposable PostgreSQL URLs are required");
    const now: Instant = Instant.parse(new Date().toISOString());
    const admin: Sql = postgres(adminDatabaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
    });
    let transferredContentBytes: number = 0;
    const app: Sql = postgres(databaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
      transform: {
        row: (row: Record<string, unknown>): Record<string, unknown> => {
          const directContent: unknown = row["content"];
          if (typeof directContent === "string")
            transferredContentBytes += Buffer.byteLength(directContent);
          const text: unknown = row["row_json"];
          if (typeof text === "string") {
            const parsed: { readonly content: string } = z
              .object({ content: z.string() })
              .parse(JSON.parse(text));
            transferredContentBytes += Buffer.byteLength(parsed.content);
          }
          return row;
        },
      },
    });
    const tenant: TenantId = TenantId.generate();
    const other: TenantId = TenantId.generate();
    const read: (
      overrides?: Partial<ListNoticesQuery>,
      selected?: TenantId,
    ) => Promise<ListNoticesResult> = async (
      overrides: Partial<ListNoticesQuery> = {},
      selected: TenantId = tenant,
    ): Promise<ListNoticesResult> =>
      await listPostgresNotices(app, selected, { ...noticePageQuery(), ...overrides }, now);
    try {
      for (const selected of [tenant, other]) {
        await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
          VALUES (${selected.value}::uuid, ${`notice-page-${selected.value}`}, 'Notice page fixture')`;
        await admin`INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
          VALUES (${selected.value}::uuid, 'reader', 'Reader', '{}'::jsonb, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`;
      }
      for (let index: number = 1; index <= 7; index += 1) {
        await admin`INSERT INTO murmur.notices(tenant_id, notice_id, kind, creator_id, creator_generation,
          repository_name, content, created_at, expires_at)
          VALUES (${tenant.value}::uuid, ${noticePageRow(index, "").notice_id}::uuid, 'handoff', 'reader', 1,
            'audit/notices', ${"\u0001".repeat(100_000)}, ${now.toISOString()}::timestamptz,
            ${now.addHours(24).toISOString()}::timestamptz)`;
      }
      await admin`INSERT INTO murmur.notices(tenant_id, notice_id, kind, creator_id, creator_generation,
        repository_name, content, created_at, expires_at)
        VALUES (${other.value}::uuid, ${noticePageRow(1, "").notice_id}::uuid, 'handoff', 'reader', 1,
          'audit/notices', 'other tenant fixture', ${now.toISOString()}::timestamptz,
          ${now.addHours(24).toISOString()}::timestamptz)`;
      expect<unknown>(await app`SELECT current_user AS name`).toEqual([{ name: "murmur_app" }]);
      const budget: MaterializationByteBudget = new MaterializationByteBudget(
        MAX_NOTICE_PAGE_BYTES,
      );
      const scope: MaterializationScope = new MaterializationScope(budget);
      const finish: () => void = scope.startHandler();
      let first: ListNoticesResult;
      try {
        first = await withMaterializationScope(
          scope,
          async (): Promise<ListNoticesResult> => await read(),
        );
        expect(first.notices).toHaveLength(6);
        expect(ids(first)).toEqual(
          Array.from(
            { length: 6 },
            (_value: unknown, index: number): string => noticePageRow(index + 1, "").notice_id,
          ),
        );
        expect(transferredContentBytes).toBe(600_000);
        expect(budget.reservedBytes).toBe(6 * (13 * 100_000 + NOTICE_PAGE_ROW_BYTES));
        finish();
        expect(budget.reservedBytes).toBeGreaterThan(0);
        scope.finishResponse();
        expect(budget.reservedBytes).toBe(0);
      } finally {
        finish();
        scope.finishResponse();
      }
      transferredContentBytes = 0;
      const last: ListNoticesResult = await read({ cursor: first.nextCursor });
      expect(ids(last)).toEqual([noticePageRow(7, "").notice_id]);
      expect(last.nextCursor).toBeNull();
      expect(transferredContentBytes).toBe(100_000);
      transferredContentBytes = 0;
      expect((await read({ limit: 1 })).notices).toHaveLength(1);
      expect(transferredContentBytes).toBe(100_000);
      const foreign: ListNoticesResult = await read({}, other);
      expect(foreign.notices.map((notice: Notice): string => notice.content.value)).toEqual([
        "other tenant fixture",
      ]);
      await expect(read({ actorId: AgentId.parse("unknown") })).rejects.toThrow("Unknown agent");

      await admin`UPDATE murmur.notices SET repository_name = 'other/repository' WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(1, "").notice_id}::uuid`;
      await admin`UPDATE murmur.notices SET branch_name = 'feature/two' WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(2, "").notice_id}::uuid`;
      await admin`UPDATE murmur.notices SET kind = 'decision' WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(3, "").notice_id}::uuid`;
      await admin`UPDATE murmur.notices SET resolved_at = ${now.toISOString()}::timestamptz,
        resolved_by_id = 'reader', resolved_by_generation = 1, resolution_note = 'done'
        WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(4, "").notice_id}::uuid`;
      await admin`UPDATE murmur.notices SET withdrawn_at = ${now.toISOString()}::timestamptz,
        withdrawn_by_id = 'reader', withdrawn_by_generation = 1, resolution_note = 'withdrawn'
        WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(5, "").notice_id}::uuid`;
      await admin`UPDATE murmur.notices SET created_at = ${now.toISOString()}::timestamptz - interval '1 hour',
        expires_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(6, "").notice_id}::uuid`;
      await admin`UPDATE murmur.notices SET created_at = ${now.toISOString()}::timestamptz - interval '2 hours'
        WHERE tenant_id = ${tenant.value}::uuid AND notice_id = ${noticePageRow(7, "").notice_id}::uuid`;
      expect(ids(await read({ repositoryName: RepositoryName.parse("other/repository") }))).toEqual(
        [noticePageRow(1, "").notice_id],
      );
      expect(ids(await read({ branchName: BranchName.parse("feature/two") }))).toEqual([
        noticePageRow(2, "").notice_id,
      ]);
      expect(ids(await read({ kind: "decision" }))).toEqual([noticePageRow(3, "").notice_id]);
      expect(ids(await read({ state: "resolved" }))).toEqual([noticePageRow(4, "").notice_id]);
      expect(ids(await read({ state: "withdrawn" }))).toEqual([noticePageRow(5, "").notice_id]);
      expect(ids(await read({ state: "expired" }))).toEqual([noticePageRow(6, "").notice_id]);
      const open: ListNoticesResult = await read({ state: "open", limit: 2 });
      expect(ids(open)).toEqual([noticePageRow(2, "").notice_id, noticePageRow(3, "").notice_id]);
      expect(ids(await read({ state: "open", cursor: open.nextCursor }))).toEqual([
        noticePageRow(7, "").notice_id,
      ]);
      transferredContentBytes = 0;
      const emptyScope: MaterializationScope = new MaterializationScope(budget);
      try {
        await withMaterializationScope(emptyScope, async (): Promise<void> => {
          expect(
            (await read({ repositoryName: RepositoryName.parse("missing/repository") })).notices,
          ).toEqual([]);
          expect(budget.reservedBytes).toBe(0);
        });
        expect(transferredContentBytes).toBe(0);
      } finally {
        emptyScope.finishResponse();
      }
    } finally {
      try {
        await app.end({ timeout: 1 });
      } finally {
        try {
          await cleanup(admin, [tenant, other]);
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    }
  },
  30_000,
);
