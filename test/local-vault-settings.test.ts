import { Database, type Statement } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrateLocalVault } from "../src/e2ee/local-vault-schema.js";
import {
  LocalVaultSettings,
  type StoredOrchestrationRoute,
} from "../src/e2ee/local-vault-settings.js";

test("retained orchestration routes without a machine qualifier upgrade as global", (): void => {
  using database: Database = new Database(":memory:", { create: true, strict: true });
  migrateLocalVault(database);
  using statement: Statement<unknown, [string, string, string]> = database.prepare(`
    INSERT INTO orchestration_routes(logical_id, orchestrator_json, expires_at)
    VALUES (?, ?, ?)
  `);
  statement.run(
    "legacy-route",
    JSON.stringify({
      agent_id: "legacy-orchestrator",
      policy_id: "20000000-0000-4000-8000-000000000001",
      scope: {
        personal_id: null,
        repository: null,
        scope_kind: "organization",
      },
    }),
    "2027-01-01T00:00:00.000Z",
  );
  const settings: LocalVaultSettings = new LocalVaultSettings(database);
  const route: StoredOrchestrationRoute | null = settings.getOrchestrationRoute(
    "legacy-route",
    "2026-09-07T00:00:00.000Z",
  );
  expect(route).not.toBeNull();
  expect(route === null ? undefined : route.orchestrator.scope.machine).toBeNull();
});
