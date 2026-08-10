import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

import {
  type EffectiveOrchestratorDto,
  EffectiveOrchestratorDtoSchema,
} from "../hosted/orchestration-contracts.js";

export type ActiveTenantBinding = {
  readonly boundAt: string;
  readonly tenantId: string;
};

type ActiveTenantBindingRow = {
  readonly bound_at: string;
  readonly tenant_id: string;
};

const ActiveTenantBindingRowSchema: z.ZodType<ActiveTenantBindingRow> = z.strictObject({
  bound_at: z.iso.datetime({ offset: true }),
  tenant_id: z.string().uuid(),
});

export type StoredOrchestrationRoute = {
  readonly expiresAt: string;
  readonly orchestrator: EffectiveOrchestratorDto;
};

type OrchestrationRouteRow = {
  readonly expires_at: string;
  readonly orchestrator_json: string;
};

const OrchestrationRouteRowSchema: z.ZodType<OrchestrationRouteRow> = z.strictObject({
  expires_at: z.iso.datetime({ offset: true }),
  orchestrator_json: z.string().min(1).max(2048),
});
const LogicalIdSchema: z.ZodString = z.string().min(1).max(200);

export class LocalVaultSettings {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public bindActiveTenant(tenantIdInput: string, boundAtInput: string): ActiveTenantBinding {
    const input: ActiveTenantBindingRow = ActiveTenantBindingRowSchema.parse({
      bound_at: boundAtInput,
      tenant_id: tenantIdInput,
    });
    const current: ActiveTenantBinding | null = this.getActiveTenant();
    if (current !== null && current.tenantId !== input.tenant_id) {
      throw new Error(
        "The local E2E vault is already bound to another tenant; use a separate vault path",
      );
    }
    using statement: Statement<unknown, [string, string]> = this.#database.prepare(`
      INSERT INTO active_tenant_binding(singleton, tenant_id, bound_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        bound_at = excluded.bound_at
    `);
    statement.run(input.tenant_id, input.bound_at);
    return { boundAt: input.bound_at, tenantId: input.tenant_id };
  }

  public getActiveTenant(): ActiveTenantBinding | null {
    using statement: Statement<unknown, []> = this.#database.prepare(`
      SELECT tenant_id, bound_at FROM active_tenant_binding WHERE singleton = 1
    `);
    const row: unknown = statement.get();
    if (row === null) return null;
    const parsed: ActiveTenantBindingRow = ActiveTenantBindingRowSchema.parse(row);
    return { boundAt: parsed.bound_at, tenantId: parsed.tenant_id };
  }

  public getOrchestrationRoute(
    logicalIdInput: string,
    nowInput: string,
  ): StoredOrchestrationRoute | null {
    const logicalId: string = LogicalIdSchema.parse(logicalIdInput);
    const now: string = z.iso.datetime({ offset: true }).parse(nowInput);
    using statement: Statement<unknown, [string, string]> = this.#database.prepare(`
      SELECT orchestrator_json, expires_at FROM orchestration_routes
      WHERE logical_id = ? AND expires_at > ?
    `);
    const raw: unknown = statement.get(logicalId, now);
    if (raw === null) return null;
    const row: OrchestrationRouteRow = OrchestrationRouteRowSchema.parse(raw);
    return {
      expiresAt: row.expires_at,
      orchestrator: EffectiveOrchestratorDtoSchema.parse(JSON.parse(row.orchestrator_json)),
    };
  }

  public bindOrchestrationRoute(
    logicalIdInput: string,
    orchestratorInput: EffectiveOrchestratorDto,
    expiresAtInput: string,
    nowInput: string,
  ): StoredOrchestrationRoute {
    const logicalId: string = LogicalIdSchema.parse(logicalIdInput);
    const orchestrator: EffectiveOrchestratorDto =
      EffectiveOrchestratorDtoSchema.parse(orchestratorInput);
    const expiresAt: string = z.iso.datetime({ offset: true }).parse(expiresAtInput);
    using insert: Statement<unknown, [string, string, string]> = this.#database.prepare(`
      INSERT OR IGNORE INTO orchestration_routes(logical_id, orchestrator_json, expires_at)
      VALUES (?, ?, ?)
    `);
    insert.run(logicalId, JSON.stringify(orchestrator), expiresAt);
    const stored: StoredOrchestrationRoute | null = this.getOrchestrationRoute(logicalId, nowInput);
    if (stored === null || JSON.stringify(stored.orchestrator) !== JSON.stringify(orchestrator)) {
      throw new Error("Encrypted orchestrator idempotency route conflict");
    }
    return stored;
  }

  public purgeExpiredOrchestrationRoutes(nowInput: string): number {
    const now: string = z.iso.datetime({ offset: true }).parse(nowInput);
    using statement: Statement<unknown, [string]> = this.#database.prepare(
      "DELETE FROM orchestration_routes WHERE expires_at <= ?",
    );
    return statement.run(now).changes;
  }
}
