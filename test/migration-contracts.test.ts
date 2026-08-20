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
