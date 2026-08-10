import type { Database, Statement } from "bun:sqlite";
import { z } from "zod";

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
    const statement: Statement<unknown, [string, string]> = this.#database.query(`
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
    const statement: Statement<unknown, []> = this.#database.query(`
      SELECT tenant_id, bound_at FROM active_tenant_binding WHERE singleton = 1
    `);
    const row: unknown = statement.get();
    if (row === null) return null;
    const parsed: ActiveTenantBindingRow = ActiveTenantBindingRowSchema.parse(row);
    return { boundAt: parsed.bound_at, tenantId: parsed.tenant_id };
  }
}
