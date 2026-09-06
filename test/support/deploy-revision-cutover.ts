import { execFile, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { appendFileSync, constants, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const READY_REVISION: string = "murmur-00042-safe";
export const CUTOVER_SENTINEL: string = "PRIVATE_CUTOVER_DIAGNOSTIC_MUST_NOT_ESCAPE";
export type CutoverStage = "ready" | "traffic" | "retained" | "health";
export type CutoverOptions = {
  readonly readyRevision?: string | undefined;
  readonly revisionNames?: readonly string[] | undefined;
  readonly failureAt?: CutoverStage | undefined;
  readonly timeoutAt?: CutoverStage | undefined;
  readonly missingTool?: "gcloud" | "curl" | "timeout" | undefined;
};
const OptionsSchema: z.ZodType<CutoverOptions> = z.strictObject({
  readyRevision: z.string().max(4_096).optional(),
  revisionNames: z.array(z.string().max(4_096)).max(10).optional(),
  failureAt: z.enum(["ready", "traffic", "retained", "health"]).optional(),
  timeoutAt: z.enum(["ready", "traffic", "retained", "health"]).optional(),
  missingTool: z.enum(["gcloud", "curl", "timeout"]).optional(),
});
export type CutoverCommand = { readonly command: string; readonly arguments: string[] };
const CommandSchema: z.ZodType<CutoverCommand> = z.strictObject({
  command: z.enum(["gcloud", "curl", "timeout"]),
  arguments: z.array(z.string()).max(30),
});
export type CutoverResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: CutoverCommand[];
};

async function bashExecutable(): Promise<string> {
  const search: string | undefined = process.env["PATH"];
  if (search === undefined) throw new Error("Linux cutover fixture requires a command search path");
  for (const directory of search.split(delimiter)) {
    const candidate: string = join(directory, "bash");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error: unknown) {
      const failure: { code?: string | undefined } = z
        .object({ code: z.string().optional() })
        .parse(error);
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(failure.code ?? "")) throw error;
    }
  }
  throw new Error("Linux cutover fixture requires bash");
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runCutoverFixture(
  options: CutoverOptions = {},
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<CutoverResult> {
  if (process.platform !== "linux") throw new Error("Cutover shell fixture is Linux-only");
  const bash: string = await bashExecutable();
  const directory: string = await mkdtemp(join(tmpdir(), "murmur-revision-cutover-"));
  const configuration: string = join(directory, "configuration.json");
  const log: string = join(directory, "commands.jsonl");
  try {
    await writeFile(configuration, JSON.stringify(OptionsSchema.parse(options)), { mode: 0o600 });
    await writeFile(log, "", { mode: 0o600 });
    for (const command of ["gcloud", "curl", "timeout"]) {
      if (options.missingTool === command) continue;
      await writeFile(
        join(directory, command),
        `#!${bash}\nexec ${quoted(process.execPath)} ${quoted(fileURLToPath(import.meta.url))} ${quoted(command)} "$@"\n`,
        { mode: 0o700 },
      );
    }
    const result: { code: number; stdout: string; stderr: string } = await new Promise(
      (resolve: (result: { code: number; stdout: string; stderr: string }) => void): void => {
        execFile(
          bash,
          [fileURLToPath(new URL("../../scripts/deploy/preserve-revisions.sh", import.meta.url))],
          {
            encoding: "utf8",
            timeout: 10_000,
            killSignal: "SIGKILL",
            maxBuffer: 65_536,
            env: {
              PATH: directory,
              PROJECT_ID: "test-project",
              REGION: "us-central1",
              SERVICE: "murmur",
              PRODUCTION_URL: "https://murmur.example.test/",
              TENANT_CONTRACT_FINALIZE_REQUIRED: "false",
              CUTOVER_FIXTURE_CONFIGURATION: configuration,
              CUTOVER_FIXTURE_LOG: log,
              ...environment,
            },
          },
          (error: unknown, stdout: string, stderr: string): void => {
            const parsed: z.ZodSafeParseResult<{ code?: number | string | undefined }> = z
              .object({ code: z.union([z.number(), z.string()]).optional() })
              .safeParse(error);
            const code: number =
              error === null
                ? 0
                : parsed.success && typeof parsed.data.code === "number"
                  ? parsed.data.code
                  : -1;
            resolve({ code, stdout, stderr });
          },
        );
      },
    );
    const calls: CutoverCommand[] = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line: string): boolean => line.length > 0)
      .map((line: string): CutoverCommand => CommandSchema.parse(JSON.parse(line)));
    return { ...result, calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class FixtureExit extends Error {
  constructor(readonly code: number) {
    super("Fixture command failed");
  }
}

function failDriver(code: number = 97): never {
  throw new FixtureExit(code);
}

async function writeOutput(stream: Writable, value: string): Promise<void> {
  if (value.length === 0) return;
  await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    stream.write(value, (error: Error | null | undefined): void => {
      if (error === null || error === undefined) resolve();
      else reject(new FixtureExit(98));
    });
  });
}

function exitForBrokenPipe(): never {
  process.exit(98);
}

function commandStage(command: string, args: readonly string[], ready: string): CutoverStage {
  const serialized: string = JSON.stringify(args);
  if (command === "gcloud") {
    if (
      serialized ===
      JSON.stringify([
        "run",
        "services",
        "describe",
        "murmur",
        "--project",
        "test-project",
        "--region",
        "us-central1",
        "--format",
        "value(status.latestReadyRevisionName)",
      ])
    )
      return "ready";
    if (
      serialized ===
      JSON.stringify([
        "run",
        "services",
        "update-traffic",
        "murmur",
        "--project",
        "test-project",
        "--region",
        "us-central1",
        "--to-latest",
        "--clear-tags",
        "--quiet",
      ])
    )
      return "traffic";
    if (
      serialized ===
      JSON.stringify([
        "run",
        "revisions",
        "list",
        "--project",
        "test-project",
        "--region",
        "us-central1",
        "--service",
        "murmur",
        "--filter",
        `metadata.name!=${ready}`,
        "--limit",
        "1",
        "--format",
        "value(metadata.name)",
      ])
    )
      return "retained";
    if (
      serialized ===
      JSON.stringify([
        "run",
        "revisions",
        "list",
        "--project",
        "test-project",
        "--region",
        "us-central1",
        "--service",
        "murmur",
        "--limit",
        "2",
        "--format",
        "value(metadata.name)",
      ])
    )
      return "retained";
  }
  if (
    command === "curl" &&
    serialized ===
      JSON.stringify([
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "https://murmur.example.test/health",
      ])
  )
    return "health";
  return failDriver();
}

async function driver(): Promise<void> {
  const configuration: string | undefined = process.env["CUTOVER_FIXTURE_CONFIGURATION"];
  const log: string | undefined = process.env["CUTOVER_FIXTURE_LOG"];
  if (configuration === undefined || log === undefined) failDriver();
  const options: CutoverOptions = OptionsSchema.parse(
    JSON.parse(readFileSync(configuration, "utf8")),
  );
  const ready: string = options.readyRevision ?? READY_REVISION;
  const command: string | undefined = process.argv[2];
  const args: string[] = process.argv.slice(3);
  const call: CutoverCommand = CommandSchema.parse({ command, arguments: args });
  appendFileSync(log, `${JSON.stringify(call)}\n`);
  if (command === "timeout") {
    const duration: string | undefined = args[2];
    const invoked: string | undefined = args[3];
    if (
      args[0] !== "--signal=TERM" ||
      args[1] !== "--kill-after=1s" ||
      duration === undefined ||
      !/^(?:[1-9]|[12][0-9]|30)s$/u.test(duration) ||
      invoked === undefined ||
      !["gcloud", "curl"].includes(invoked)
    )
      failDriver();
    const stage: CutoverStage = commandStage(invoked, args.slice(4), ready);
    if (options.timeoutAt === stage) failDriver(124);
    const child: SpawnSyncReturns<string> = spawnSync(invoked, args.slice(4), {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 4_000,
      maxBuffer: 65_536,
    });
    if (typeof child.stdout === "string") await writeOutput(process.stdout, child.stdout);
    if (typeof child.stderr === "string") await writeOutput(process.stderr, child.stderr);
    process.exit(child.status ?? 98);
  }
  if (command === undefined) failDriver();
  const stage: CutoverStage = commandStage(command, args, ready);
  if (options.failureAt === stage) failDriver(9);
  if (stage === "ready") await writeOutput(process.stdout, `${ready}\n`);
  else if (stage === "retained") {
    const names: readonly string[] = options.revisionNames ?? [ready];
    // The old CLI combination limits the unfiltered server page before applying its local filter.
    const selected: readonly string[] = args.includes("--filter")
      ? names.slice(0, 1).filter((name: string): boolean => name !== ready)
      : names.slice(0, 2);
    await writeOutput(process.stdout, `${selected.join("\n")}\n`);
  } else await writeOutput(process.stdout, CUTOVER_SENTINEL);
}

if (import.meta.main) {
  process.stdout.on("error", exitForBrokenPipe);
  process.stderr.on("error", exitForBrokenPipe);
  try {
    await driver();
  } catch (error: unknown) {
    await writeOutput(process.stdout, CUTOVER_SENTINEL);
    await writeOutput(process.stderr, CUTOVER_SENTINEL);
    process.exit(error instanceof FixtureExit ? error.code : 97);
  }
}
