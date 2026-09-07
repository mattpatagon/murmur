import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

test("lifecycle migration phases are independently tracked and replayable", async (): Promise<void> => {
  const migrationNames: string[] = (await readdir("supabase/migrations"))
    .filter((name: string): boolean => name.startsWith("202608101600") && name.endsWith(".sql"))
    .sort();
  expect(migrationNames).toEqual([
    "20260810160000_agent_lifecycle_columns.sql",
    "20260810160001_agent_lifecycle_validations.sql",
    "20260810160002_agent_sessions.sql",
    "20260810160003_agent_lifecycle_functions.sql",
    "20260810160004_agent_quota_cutover.sql",
    "20260810160005_message_generation_columns.sql",
    "20260810160006_message_generation_validations.sql",
    "20260810160007_message_generation_triggers.sql",
    "20260810160008_coordination_notices.sql",
    "20260810160009_message_generation_index.sql",
    "20260810160010_agent_lifecycle_indexes.sql",
  ]);
  for (const migrationName of migrationNames) {
    const contents: string = await Bun.file(`supabase/migrations/${migrationName}`).text();
    const begins: RegExpMatchArray | null = contents.match(/^begin;$/gmu);
    const commits: RegExpMatchArray | null = contents.match(/^commit;$/gmu);
    const beginCount: number = begins === null ? 0 : begins.length;
    const commitCount: number = commits === null ? 0 : commits.length;
    expect(beginCount).toBeLessThanOrEqual(1);
    expect(commitCount).toBeLessThanOrEqual(1);
    expect(beginCount).toBe(commitCount);
  }
});

test("feedback migration is tenant-isolated, append-only at runtime, and quota bounded", async (): Promise<void> => {
  const contents: string = await Bun.file(
    "supabase/migrations/20260820010000_feedback_submissions.sql",
  ).text();
  expect(contents).toContain("alter table murmur.feedback_submissions force row level security");
  expect(contents).toContain(
    "grant select, insert on table murmur.feedback_submissions to murmur_app",
  );
  expect(contents).not.toContain(
    "grant select, insert, update, delete on table murmur.feedback_submissions",
  );
  expect(contents).toContain("usage.feedback_submission_count < 10000");
  expect(contents).toContain("usage.feedback_content_bytes + content_bytes <= 67108864");
  expect(contents).toContain("tenant retained-feedback quota exceeded");
});

test("connector provenance constraints are staged, bounded, and restart-safe", async (): Promise<void> => {
  const migrationNames: readonly string[] = [
    "20260902175459_allow_connector_client.sql",
    "20260902175500_validate_message_connector_client.sql",
    "20260902175501_validate_broadcast_connector_client.sql",
    "20260902175502_validate_feedback_connector_client.sql",
    "20260902175503_finalize_connector_client_constraints.sql",
  ];
  const migrations: readonly string[] = await Promise.all(
    migrationNames.map(
      async (name: string): Promise<string> => await Bun.file(`supabase/migrations/${name}`).text(),
    ),
  );
  migrations.forEach((contents: string): void => {
    expect(contents.match(/^begin;$/gmu)).toHaveLength(1);
    expect(contents.match(/^commit;$/gmu)).toHaveLength(1);
    expect(contents).toContain("set local lock_timeout = '5s'");
  });

  const expansion: string | undefined = migrations[0];
  const finalization: string | undefined = migrations[4];
  if (expansion === undefined || finalization === undefined) {
    throw new Error("Connector constraint migration phases are missing");
  }
  expect(expansion.match(/not valid/gu)).toHaveLength(3);
  expect(expansion.match(/'connector'/gu)).toHaveLength(3);
  expect(expansion).not.toContain("validate constraint");
  migrations.slice(1, 4).forEach((contents: string): void => {
    expect(contents.match(/validate constraint/gu)).toHaveLength(1);
    expect(contents).not.toContain("drop constraint");
  });
  expect(finalization.match(/drop constraint/gu)).toHaveLength(3);
  expect(finalization.match(/rename constraint/gu)).toHaveLength(3);
  expect(migrations.join("\n")).not.toContain("chatgpt");
  expect(migrations.join("\n")).not.toContain("grok");
});

test("client slug constraints are staged, bounded, and restart-safe", async (): Promise<void> => {
  const migrationNames: readonly string[] = [
    "20260906040000_allow_client_slugs.sql",
    "20260906040001_validate_message_client_slug.sql",
    "20260906040002_validate_broadcast_client_slug.sql",
    "20260906040003_validate_feedback_client_slug.sql",
    "20260906040004_finalize_client_slug_constraints.sql",
  ];
  const migrations: readonly string[] = await Promise.all(
    migrationNames.map(
      async (name: string): Promise<string> => await Bun.file(`supabase/migrations/${name}`).text(),
    ),
  );
  migrations.forEach((contents: string): void => {
    expect(contents.match(/^begin;$/gmu)).toHaveLength(1);
    expect(contents.match(/^commit;$/gmu)).toHaveLength(1);
    expect(contents).toContain("set local lock_timeout = '5s'");
  });

  const expansion: string | undefined = migrations[0];
  const finalization: string | undefined = migrations[4];
  if (expansion === undefined || finalization === undefined) {
    throw new Error("Client slug constraint migration phases are missing");
  }
  expect(expansion.match(/not valid/gu)).toHaveLength(3);
  expect(expansion.match(/\^\[a-z\]\[a-z0-9-\]\{0,31\}\$/gu)).toHaveLength(3);
  expect(expansion).not.toContain("validate constraint");
  migrations.slice(1, 4).forEach((contents: string): void => {
    expect(contents.match(/validate constraint/gu)).toHaveLength(1);
    expect(contents).not.toContain("drop constraint");
  });
  expect(finalization.match(/drop constraint/gu)).toHaveLength(3);
  expect(finalization.match(/rename constraint/gu)).toHaveLength(3);
});

test("machine orchestration migration preserves old scopes with bounded expand/index/contract phases", async (): Promise<void> => {
  const expansion: string = await Bun.file(
    "supabase/migrations/20260907190000_machine_bound_orchestration_expand.sql",
  ).text();
  const indexes: string = await Bun.file(
    "supabase/migrations/20260907190001_machine_bound_orchestration_indexes.sql",
  ).text();
  const contract: string = await Bun.file(
    "supabase/migrations/20260907190002_machine_bound_orchestration_contract.sql",
  ).text();
  for (const contents of [expansion, contract]) {
    expect(contents.match(/^begin;$/gmu)).toHaveLength(1);
    expect(contents.match(/^commit;$/gmu)).toHaveLength(1);
    expect(contents).toContain("set local lock_timeout = '5s'");
    expect(contents).toContain("set local statement_timeout");
  }
  expect(expansion).toContain("add column machine_name text");
  expect(expansion).toContain("add column machine_name text not null default ''");
  expect(expansion).toContain("authenticate_principal_v3");
  expect(expansion).toContain("authenticate_principal_v2(p_secret_hash)");
  expect(expansion).not.toContain("drop function murmur.authenticate_principal_v2");
  expect(expansion.indexOf("pg_advisory_xact_lock")).toBeLessThan(expansion.indexOf("if exists"));
  expect(indexes).toContain("set statement_timeout = '15min'");
  expect(indexes.match(/create (?:unique )?index concurrently/gu)).toHaveLength(2);
  expect(indexes.match(/not index_state.indisvalid/gu)).toHaveLength(2);
  expect(contract).toContain("unique using index orchestrator_policies_scope_machine_unique");
  expect(contract).toContain("rename to orchestrator_policies_resolution");
});
