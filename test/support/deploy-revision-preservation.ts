import { execFile, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { appendFileSync, constants, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { z } from "zod";

// biome-ignore lint/security/noSecrets: This is the release's Git source identifier, not credential material.
export const REVISION_FLOOR: string = "d89d405db3bc470bfe375abe7dfd474738b82607";
export const DEPLOY_HEAD: string = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const PRESERVED_SOURCE: string = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const IMAGE_PREFIX: string = "us-central1-docker.pkg.dev/test-project/runtime/murmur:";
export const PRESERVED_DIGEST: string = `sha256:${"c".repeat(64)}`;
export const DIGEST_IMAGE: string = `${IMAGE_PREFIX.slice(0, -1)}@${PRESERVED_DIGEST}`;
export const REGISTRY_PACKAGE: string =
  "projects/test-project/locations/us-central1/repositories/runtime/packages/murmur";
export const PRIVATE_SENTINEL: string = "PRIVATE_REVISION_DIAGNOSTIC_MUST_NOT_ESCAPE";
// biome-ignore lint/security/noSecrets: This is GNU head's fixed byte-count option, not credential material.
const CAPTURE_BYTE_OPTION: string = "--bytes=1048577";

export type RevisionFixtureOptions = {
  readonly inventory: string;
  readonly shallow?: string | undefined;
  readonly nonCommit?: string | undefined;
  readonly missingCommit?: string | undefined;
  readonly ancestryFailure?: "floor" | "head" | undefined;
  readonly failGcloud?: boolean | undefined;
  readonly registryTags?: string | undefined;
  readonly registryImage?: string | undefined;
  readonly failRegistry?: "tags" | "image" | undefined;
  readonly timeoutTarget?:
    | "history"
    | "cloud"
    | "capture"
    | "metadata"
    | "images"
    | "source"
    | "ancestry"
    | "registry-tags"
    | "registry-image"
    | undefined;
  readonly missingTool?: "gcloud" | "git" | "jq" | "head" | "timeout" | undefined;
};
const OptionsSchema: z.ZodType<RevisionFixtureOptions> = z.strictObject({
  inventory: z.string().max(1_100_000),
  shallow: z.string().optional(),
  nonCommit: z.string().optional(),
  missingCommit: z.string().optional(),
  ancestryFailure: z.enum(["floor", "head"]).optional(),
  failGcloud: z.boolean().optional(),
  registryTags: z.string().max(1_100_000).optional(),
  registryImage: z.string().max(1_100_000).optional(),
  failRegistry: z.enum(["tags", "image"]).optional(),
  timeoutTarget: z
    .enum([
      "history",
      "cloud",
      "capture",
      "metadata",
      "images",
      "source",
      "ancestry",
      "registry-tags",
      "registry-image",
    ])
    .optional(),
  missingTool: z.enum(["gcloud", "git", "jq", "head", "timeout"]).optional(),
});
export type RevisionCommand = { readonly command: string; readonly arguments: string[] };
const CommandSchema: z.ZodType<RevisionCommand> = z.strictObject({
  command: z.enum(["gcloud", "git", "timeout"]),
  arguments: z.array(z.string()).max(30),
});
export type RevisionFixtureResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: RevisionCommand[];
};

export function revisionInventory(images: readonly string[]): string {
  return JSON.stringify(
    images.map((image: string): object => ({ spec: { containers: [{ image }] } })),
  );
}

async function executable(name: string): Promise<string> {
  const search: string | undefined = process.env["PATH"];
  if (search === undefined) throw new Error("Linux revision test requires a command search path");
  for (const directory of search.split(delimiter)) {
    const candidate: string = join(directory, name);
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
  throw new Error(`Linux revision test requires ${name}`);
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runRevisionFixture(
  options: RevisionFixtureOptions,
  environment: Readonly<Record<string, string>> = {},
): Promise<RevisionFixtureResult> {
  if (process.platform !== "linux") throw new Error("Revision shell fixture is Linux-only");
  const bash: string = await executable("bash");
  const jq: string = await executable("jq");
  const head: string = await executable("head");
  const directory: string = await mkdtemp(join(tmpdir(), "murmur-revision-preservation-"));
  const configuration: string = join(directory, "configuration.json");
  const log: string = join(directory, "commands.jsonl");
  try {
    await writeFile(configuration, JSON.stringify(OptionsSchema.parse(options)), { mode: 0o600 });
    await writeFile(log, "", { mode: 0o600 });
    for (const command of ["gcloud", "git", "timeout"]) {
      if (options.missingTool === command) continue;
      await writeFile(
        join(directory, command),
        `#!${bash}\nexec ${quoted(process.execPath)} ${quoted(fileURLToPath(import.meta.url))} ${quoted(command)} "$@"\n`,
        { mode: 0o700 },
      );
    }
    if (options.missingTool !== "jq") await symlink(jq, join(directory, "jq"));
    if (options.missingTool !== "head") await symlink(head, join(directory, "head"));
    const result: { code: number; stdout: string; stderr: string } = await new Promise(
      (resolve: (result: { code: number; stdout: string; stderr: string }) => void): void => {
        execFile(
          bash,
          [
            fileURLToPath(
              new URL("../../scripts/deploy/verify-preserved-revisions.sh", import.meta.url),
            ),
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            killSignal: "SIGKILL",
            maxBuffer: 65_536,
            env: {
              PATH: directory,
              PROJECT_ID: "test-project",
              REGION: "us-central1",
              ARTIFACT_REPOSITORY: "runtime",
              SERVICE: "murmur",
              GITHUB_SHA: DEPLOY_HEAD,
              REVISION_FIXTURE_CONFIGURATION: configuration,
              REVISION_FIXTURE_LOG: log,
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
    const calls: RevisionCommand[] = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line: string): boolean => line.length > 0)
      .map((line: string): RevisionCommand => CommandSchema.parse(JSON.parse(line)));
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

function timeoutMatches(
  target: RevisionFixtureOptions["timeoutTarget"],
  args: readonly string[],
): boolean {
  if (target === "history") return args[3] === "git" && args[4] === "rev-parse";
  if (target === "cloud") return args[3] === "gcloud";
  if (target === "capture") return args[3] === "head";
  if (target === "metadata") return args[3] === "jq" && args[4] === "--exit-status";
  if (target === "images") return args[3] === "jq" && args[4] === "--raw-output";
  if (target === "source")
    return args[3] === "git" && args[4] === "cat-file" && args[6] === PRESERVED_SOURCE;
  if (target === "registry-tags") return args[3] === "gcloud" && args[5] === "tags";
  if (target === "registry-image") return args[3] === "gcloud" && args[6] === "images";
  return target === "ancestry" && args[3] === "git" && args[4] === "merge-base";
}

async function driver(): Promise<void> {
  const path: string | undefined = process.env["REVISION_FIXTURE_CONFIGURATION"];
  const log: string | undefined = process.env["REVISION_FIXTURE_LOG"];
  if (path === undefined || log === undefined) failDriver();
  const options: RevisionFixtureOptions = OptionsSchema.parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  const command: string | undefined = process.argv[2];
  const args: string[] = process.argv.slice(3);
  const call: RevisionCommand = CommandSchema.parse({ command, arguments: args });
  appendFileSync(log, `${JSON.stringify(call)}\n`);
  if (
    process.env["GIT_NO_LAZY_FETCH"] !== "1" ||
    process.env["GIT_NO_REPLACE_OBJECTS"] !== "1" ||
    process.env["GIT_TERMINAL_PROMPT"] !== "0" ||
    process.env["LC_ALL"] !== "C"
  )
    failDriver();
  if (command === "timeout") {
    const duration: string | undefined = args[2];
    const invoked: string | undefined = args[3];
    if (
      args[0] !== "--signal=TERM" ||
      args[1] !== "--kill-after=1s" ||
      duration === undefined ||
      !/^(?:[1-9]|[12][0-9]|30)s$/u.test(duration) ||
      invoked === undefined ||
      !["git", "gcloud", "jq", "head"].includes(invoked)
    )
      failDriver();
    if (
      invoked === "head" &&
      JSON.stringify(args.slice(4)) !== JSON.stringify([CAPTURE_BYTE_OPTION])
    )
      failDriver();
    if (timeoutMatches(options.timeoutTarget, args)) failDriver(124);
    const child: SpawnSyncReturns<string> = spawnSync(invoked, args.slice(4), {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 4_000,
      maxBuffer: 2 * 1_048_576,
    });
    if (typeof child.stdout === "string") await writeOutput(process.stdout, child.stdout);
    if (typeof child.stderr === "string") await writeOutput(process.stderr, child.stderr);
    process.exit(child.status ?? 98);
  }
  if (command === "gcloud") {
    if (args[0] === "artifacts") {
      const tags: boolean = args[1] === "tags";
      const expected: readonly string[] = tags
        ? [
            "artifacts",
            "tags",
            "list",
            "--package",
            "murmur",
            "--repository",
            "runtime",
            "--location",
            "us-central1",
            "--project",
            "test-project",
            "--filter",
            `version="${REGISTRY_PACKAGE}/versions/${PRESERVED_DIGEST}"`,
            "--limit",
            "1001",
            "--format",
            "json(name,version)",
            "--quiet",
          ]
        : [
            "artifacts",
            "docker",
            "images",
            "describe",
            `${IMAGE_PREFIX}${PRESERVED_SOURCE}`,
            "--project",
            "test-project",
            "--format",
            "json(image_summary.digest,image_summary.fully_qualified_digest)",
            "--quiet",
          ];
      if (JSON.stringify(args) !== JSON.stringify(expected)) failDriver();
      if (options.failRegistry === (tags ? "tags" : "image")) failDriver(9);
      const defaultTags: string = JSON.stringify([
        {
          name: `${REGISTRY_PACKAGE}/tags/${PRESERVED_SOURCE}`,
          version: `${REGISTRY_PACKAGE}/versions/${PRESERVED_DIGEST}`,
        },
      ]);
      const defaultImage: string = JSON.stringify({
        image_summary: { digest: PRESERVED_DIGEST, fully_qualified_digest: DIGEST_IMAGE },
      });
      await writeOutput(
        process.stdout,
        tags ? (options.registryTags ?? defaultTags) : (options.registryImage ?? defaultImage),
      );
      return;
    }
    if (
      JSON.stringify(args) !==
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
        "1001",
        "--format",
        "json(spec.containers[].image)",
        "--quiet",
      ])
    )
      failDriver();
    if (options.failGcloud === true) failDriver(9);
    await writeOutput(process.stdout, options.inventory);
    return;
  }
  if (command !== "git") failDriver();
  if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--is-shallow-repository"])) {
    await writeOutput(process.stdout, `${options.shallow ?? "false"}\n`);
    return;
  }
  if (args.length === 3 && args[0] === "cat-file" && args[1] === "-t") {
    if (args[2] === options.missingCommit) failDriver(1);
    await writeOutput(process.stdout, args[2] === options.nonCommit ? "blob\n" : "commit\n");
    return;
  }
  if (args.length === 4 && args[0] === "merge-base" && args[1] === "--is-ancestor") {
    if (
      (options.ancestryFailure === "floor" && args[2] === REVISION_FLOOR) ||
      (options.ancestryFailure === "head" && args[3] === DEPLOY_HEAD)
    )
      failDriver(1);
    await writeOutput(process.stdout, PRIVATE_SENTINEL);
    return;
  }
  failDriver();
}

if (import.meta.main) {
  process.stdout.on("error", exitForBrokenPipe);
  process.stderr.on("error", exitForBrokenPipe);
  try {
    await driver();
  } catch (error: unknown) {
    await writeOutput(process.stderr, PRIVATE_SENTINEL);
    process.exit(error instanceof FixtureExit ? error.code : 97);
  }
}
