import { expect, test } from "bun:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

type Outcome = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};
const ResultSchema: z.ZodType<{
  readonly passed: false;
  readonly cleanupPassed: boolean;
  readonly failure: string;
  readonly lastStage: string;
}> = z.object({
  passed: z.literal(false),
  cleanupPassed: z.boolean(),
  failure: z.string(),
  lastStage: z.string(),
});

function databaseUrl(role: string): string {
  const url: URL = new URL("postgresql://127.0.0.1/murmur_load_deadline");
  url.username = role;
  url.password = "unused";
  return url.href;
}

async function run(mode: string): Promise<Outcome> {
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [
      process.execPath,
      "--preload",
      fileURLToPath(new URL("./support/hosted-load-deadline-preload.ts", import.meta.url)),
      fileURLToPath(new URL("../scripts/verify-hosted-load.ts", import.meta.url)),
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        MURMUR_TEST_LOAD_DEADLINE_CASE: mode,
        MURMUR_LOAD_DISPOSABLE: "1",
        MURMUR_LOAD_ADMIN_DATABASE_URL: databaseUrl("fixture_owner"),
        MURMUR_LOAD_RUNTIME_DATABASE_URL: databaseUrl("murmur_app"),
        MURMUR_LOAD_TENANTS: "128",
        MURMUR_LOAD_DURATION_SECONDS: "120",
      },
      killSignal: "SIGKILL",
      timeout: 3_000,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [code, stdout, stderr]: [number, string, string] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

function expectReport(outcome: Outcome, cleanupPassed: boolean): void {
  expect(outcome.code).toBe(1);
  expect(outcome.stdout).toContain("hard-deadline:240000\n");
  expect(outcome.stdout).toContain("child-close-attempted\nfixture-close-attempted\n");
  const line: string | undefined = outcome.stdout
    .split("\n")
    .find((candidate: string): boolean => candidate.startsWith('{"event":"hosted-load-result"'));
  if (line === undefined) throw new Error("Expected hosted load result before terminal exit");
  const report: z.infer<typeof ResultSchema> = ResultSchema.parse(JSON.parse(line));
  expect(report).toEqual({
    passed: false,
    cleanupPassed,
    failure: "External operation failed",
    lastStage: "deadline-fixture",
  });
  expect(outcome.stdout).not.toContain("VERIFIER_PRIVATE_SENTINEL");
  expect(outcome.stderr).not.toContain("VERIFIER_PRIVATE_SENTINEL");
}

for (const stage of ["child", "fixture"]) {
  test(`failed ${stage} cleanup retains the hard backstop for a referenced lingering handle`, async (): Promise<void> => {
    const outcome: Outcome = await run(`${stage}-failure-live`);
    expectReport(outcome, false);
    expect(outcome.stderr).toBe("Hosted load hard deadline exceeded\n");
  });
  test(`failed ${stage} cleanup without retained handles exits without waiting for the hard backstop`, async (): Promise<void> => {
    const outcome: Outcome = await run(`${stage}-failure-idle`);
    expectReport(outcome, false);
    expect(outcome.stderr).toBe("");
  });
}

test("a workload failure with successful cleanup clears the hard timer before remaining output drains", async (): Promise<void> => {
  const outcome: Outcome = await run("workload-failure-clean");
  expectReport(outcome, true);
  expect(outcome.stdout).toContain("clean-drain-complete\n");
  expect(outcome.stderr).toBe("");
});
