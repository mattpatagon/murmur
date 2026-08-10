import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

test("lifecycle migration phases are independently tracked and replayable", async (): Promise<void> => {
  const migrationNames: string[] = (await readdir("supabase/migrations"))
    .filter((name: string): boolean => name.startsWith("2026081016") && name.endsWith(".sql"))
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
