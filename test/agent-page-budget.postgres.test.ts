import { expect, test } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { toListAgentsOutput } from "../src/domain/agent-contracts.js";
import type { Agent, ListAgentsResult } from "../src/domain/models.js";
import { AgentId, Instant, TenantId } from "../src/domain/value-objects.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import { listPostgresAgents } from "../src/storage/postgres-agent-page.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";

const configured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;
const NOW: Instant = Instant.parse("2026-09-05T00:00:00.000Z");

test.skipIf(!configured)(
  "PostgreSQL agent pages bound metadata and retain tenant-qualified cursors",
  async (): Promise<void> => {
    if (databaseUrl === undefined || adminDatabaseUrl === undefined) {
      throw new Error("Hosted PostgreSQL URLs are required");
    }
    const admin: Sql = postgres(adminDatabaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
    });
    const app: Sql = postgres(databaseUrl, {
      connection: POSTGRES_RUNTIME_CONNECTION,
      max: 1,
      ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
    });
    const tenant: TenantId = TenantId.generate();
    const other: TenantId = TenantId.generate();
    try {
      for (const id of [tenant, other]) {
        await admin`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        VALUES (${id.value}::uuid, ${`agent-page-${id.value}`}, 'Agent page fixture')`;
      }
      await admin`INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
      SELECT ${tenant.value}::uuid, 'agent-' || lpad(item::text, 4, '0'), 'Agent',
        jsonb_build_object('value', repeat('x', 16000)), ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz
      FROM generate_series(0, 299) AS item`;
      await admin`INSERT INTO murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
      VALUES (${other.value}::uuid, 'foreign-only', 'Other tenant', '{"value":"foreign"}'::jsonb, ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
      expect<unknown>(await app`SELECT current_user AS name`).toEqual([{ name: "murmur_app" }]);
      const ids: string[] = [];
      let cursor: AgentId | null = null;
      let pages: number = 0;
      do {
        const page: ListAgentsResult = await listPostgresAgents(
          app,
          tenant,
          { cursor, limit: 1_000, state: "all" },
          NOW,
        );
        expect(
          Buffer.byteLength(JSON.stringify(toolResult(toListAgentsOutput(page))), "utf8"),
        ).toBeLessThanOrEqual(8 * 1024 * 1024);
        ids.push(...page.agents.map((agent: Agent): string => agent.agentId.value));
        cursor = page.nextCursor;
        pages += 1;
        if (pages > 300) throw new Error("Agent page cursor did not advance");
      } while (cursor !== null);
      expect(pages).toBeGreaterThan(1);
      expect(ids).toHaveLength(300);
      expect(new Set(ids).size).toBe(300);
      expect(ids).toEqual([...ids].sort());
      expect(ids).not.toContain("foreign-only");
      const limited: ListAgentsResult = await listPostgresAgents(
        app,
        tenant,
        { cursor: null, limit: 7, state: "all" },
        NOW,
      );
      expect(limited.agents).toHaveLength(7);
      expect(limited.nextCursor).toEqual(AgentId.parse("agent-0006"));
      const empty: ListAgentsResult = await listPostgresAgents(
        app,
        tenant,
        { cursor: AgentId.parse("zzzz"), limit: 7, state: "all" },
        NOW,
      );
      expect(empty).toEqual({ agents: [], nextCursor: null });
      await admin`UPDATE murmur.agents SET metadata = jsonb_build_object('value', repeat('x', 3000000))
      WHERE tenant_id = ${tenant.value}::uuid AND agent_id = 'agent-0000'`;
      await expect(
        listPostgresAgents(app, tenant, { cursor: null, limit: 1_000, state: "all" }, NOW),
      ).rejects.toThrow("Stored agent exceeds the safe page size");
    } finally {
      try {
        await app.end({ timeout: 1 });
      } finally {
        try {
          for (const id of [tenant, other]) {
            await admin.begin(async (transaction: TransactionSql): Promise<void> => {
              await transaction`DELETE FROM murmur.agent_sessions WHERE tenant_id = ${id.value}::uuid`;
              await transaction`DELETE FROM murmur.agents WHERE tenant_id = ${id.value}::uuid`;
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
  },
  30_000,
);
