import { describe, expect, test } from "bun:test";
import process from "node:process";

import {
  DEPLOY_HEAD,
  IMAGE_PREFIX,
  PRESERVED_SOURCE,
  PRIVATE_SENTINEL,
  REVISION_FLOOR,
  type RevisionCommand,
  type RevisionFixtureOptions,
  type RevisionFixtureResult,
  revisionInventory,
  runRevisionFixture,
} from "./support/deploy-revision-preservation.js";

const enabled: boolean = process.env["MURMUR_TEST_DEPLOY_REVISIONS"] === "1";
if (enabled && process.platform !== "linux") {
  throw new Error("Revision preservation shell tests require the explicit Linux gate");
}

const validImage: string = `${IMAGE_PREFIX}${PRESERVED_SOURCE}`;
const validInventory: string = revisionInventory([validImage]);
const metadataError: string =
  "Revision preservation preflight received unsupported or excessive revision metadata";
const sourceError: string = "An existing revision source is absent from complete local Git history";
const requiredSourceError: string =
  "Revision preservation preflight cannot resolve its required source commits";

function expectFailure(result: RevisionFixtureResult, message: string | readonly string[]): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  const allowed: readonly string[] = typeof message === "string" ? [message] : message;
  expect(allowed.map((value: string): string => `${value}\n`)).toContain(result.stderr);
  expect(result.stderr).not.toContain(PRIVATE_SENTINEL);
  expect(result.stderr).not.toContain(IMAGE_PREFIX);
}

function argumentsFor(result: RevisionFixtureResult, command: string): string[][] {
  return result.calls
    .filter((call: RevisionCommand): boolean => call.command === command)
    .map((call: RevisionCommand): string[] => call.arguments);
}

describe.skipIf(!enabled)("Linux preserved-revision deployment guard", (): void => {
  test("empty inventory still requires complete history and both trusted commits", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({ inventory: "[]" });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Verified source compatibility for 0 preserved revisions\n");
    expect(argumentsFor(result, "git")).toEqual([
      ["rev-parse", "--is-shallow-repository"],
      ["cat-file", "-t", REVISION_FLOOR],
      ["cat-file", "-t", DEPLOY_HEAD],
    ]);
    expect(argumentsFor(result, "gcloud")).toEqual([
      [
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
      ],
    ]);
  });

  test("exact source tags and optional digests deduplicate ancestry checks, not revision counts", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({
      inventory: revisionInventory([
        validImage,
        `${validImage}@sha256:${"c".repeat(64)}`,
        `${IMAGE_PREFIX}${REVISION_FLOOR}`,
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Verified source compatibility for 3 preserved revisions\n");
    expect(argumentsFor(result, "git")).toEqual([
      ["rev-parse", "--is-shallow-repository"],
      ["cat-file", "-t", REVISION_FLOOR],
      ["cat-file", "-t", DEPLOY_HEAD],
      ["cat-file", "-t", PRESERVED_SOURCE],
      ["merge-base", "--is-ancestor", REVISION_FLOOR, PRESERVED_SOURCE],
      ["merge-base", "--is-ancestor", PRESERVED_SOURCE, DEPLOY_HEAD],
      ["cat-file", "-t", REVISION_FLOOR],
      ["merge-base", "--is-ancestor", REVISION_FLOOR, REVISION_FLOOR],
      ["merge-base", "--is-ancestor", REVISION_FLOOR, DEPLOY_HEAD],
    ]);
    for (const args of argumentsFor(result, "timeout")) {
      expect(args.slice(0, 2)).toEqual(["--signal=TERM", "--kill-after=1s"]);
      expect(args[2]).toMatch(/^(?:[1-9]|[12][0-9]|30)s$/u);
      expect(["git", "gcloud", "jq", "head"]).toContain(args[3] ?? "");
    }
  });

  for (const shallow of ["true", "false\nfalse", "", PRIVATE_SENTINEL]) {
    test(`rejects unsupported full-history result ${JSON.stringify(shallow)}`, async (): Promise<void> => {
      const result: RevisionFixtureResult = await runRevisionFixture({
        inventory: validInventory,
        shallow,
      });
      expectFailure(result, "Revision preservation preflight requires complete local Git history");
      expect(argumentsFor(result, "gcloud")).toEqual([]);
    });
  }

  for (const commit of [REVISION_FLOOR, DEPLOY_HEAD, PRESERVED_SOURCE]) {
    for (const kind of ["missingCommit", "nonCommit"]) {
      test(`rejects ${kind} for required source ${commit}`, async (): Promise<void> => {
        const options: RevisionFixtureOptions =
          kind === "missingCommit"
            ? { inventory: validInventory, missingCommit: commit }
            : { inventory: validInventory, nonCommit: commit };
        expectFailure(
          await runRevisionFixture(options),
          commit === PRESERVED_SOURCE ? sourceError : requiredSourceError,
        );
      });
    }
  }

  const ancestryFailures: readonly NonNullable<RevisionFixtureOptions["ancestryFailure"]>[] = [
    "floor",
    "head",
  ];
  for (const ancestryFailure of ancestryFailures) {
    test(`rejects incompatible ${ancestryFailure} ancestry`, async (): Promise<void> => {
      const result: RevisionFixtureResult = await runRevisionFixture({
        inventory: validInventory,
        ancestryFailure,
      });
      expectFailure(result, "An existing revision is outside the supported source ancestry");
      const ancestry: string[][] = argumentsFor(result, "git").filter(
        (args: string[]): boolean => args[0] === "merge-base",
      );
      expect(ancestry).toContainEqual([
        "merge-base",
        "--is-ancestor",
        REVISION_FLOOR,
        PRESERVED_SOURCE,
      ]);
      if (ancestryFailure === "head") {
        expect(ancestry).toContainEqual([
          "merge-base",
          "--is-ancestor",
          PRESERVED_SOURCE,
          DEPLOY_HEAD,
        ]);
      }
    });
  }

  const foreignImages: readonly string[] = [
    validImage.replace("us-central1", "us-east1"),
    validImage.replace("test-project", "other-project"),
    validImage.replace("/runtime/", "/other/"),
    validImage.replace("/murmur:", "/other:"),
    `us-central1-docker.pkg.dev/test-project/runtime/murmur-extra:${PRESERVED_SOURCE}`,
  ];
  for (const image of foreignImages) {
    test(`rejects foreign declared image ${image}`, async (): Promise<void> => {
      expectFailure(
        await runRevisionFixture({ inventory: revisionInventory([image]) }),
        "An existing revision has untrusted declared image provenance",
      );
    });
  }

  const unsupportedTags: readonly string[] = [
    "latest",
    PRESERVED_SOURCE.slice(1),
    `${PRESERVED_SOURCE}a`,
    `${PRESERVED_SOURCE}@sha256:${"c".repeat(63)}`,
    `${PRESERVED_SOURCE}@sha256:${"c".repeat(65)}`,
    `${PRESERVED_SOURCE}:other`,
    `${PRESERVED_SOURCE}@sha512:${"c".repeat(64)}`,
  ];
  for (const tag of unsupportedTags) {
    test(`rejects unsupported source tag ${tag}`, async (): Promise<void> => {
      expectFailure(
        await runRevisionFixture({ inventory: revisionInventory([`${IMAGE_PREFIX}${tag}`]) }),
        "An existing revision lacks an exact supported source tag",
      );
    });
  }

  const malformedMetadata: readonly { readonly label: string; readonly inventory: string }[] = [
    { label: "invalid JSON", inventory: PRIVATE_SENTINEL },
    { label: "multiple documents", inventory: "[]\n[]" },
    { label: "object document", inventory: "{}" },
    { label: "null row", inventory: "[null]" },
    { label: "missing spec", inventory: "[{}]" },
    { label: "missing containers", inventory: '[{"spec":{}}]' },
    { label: "empty containers", inventory: '[{"spec":{"containers":[]}}]' },
    {
      label: "multiple containers",
      inventory: JSON.stringify([
        { spec: { containers: [{ image: validImage }, { image: validImage }] } },
      ]),
    },
    { label: "nonstring image", inventory: '[{"spec":{"containers":[{"image":42}]}}]' },
    {
      label: "uppercase SHA",
      inventory: revisionInventory([`${IMAGE_PREFIX}${PRESERVED_SOURCE.toUpperCase()}`]),
    },
    {
      label: "uppercase digest",
      inventory: revisionInventory([`${validImage}@sha256:${"C".repeat(64)}`]),
    },
    { label: "Unicode image", inventory: revisionInventory([`${validImage}é`]) },
    {
      label: "embedded newline",
      inventory: revisionInventory([`${validImage}\n${PRIVATE_SENTINEL}`]),
    },
    { label: "trailing newline", inventory: revisionInventory([`${validImage}\n`]) },
    { label: "NUL byte", inventory: revisionInventory([`${validImage}\u0000`]) },
    { label: "oversized image", inventory: revisionInventory(["a".repeat(513)]) },
  ];
  for (const entry of malformedMetadata) {
    test(`rejects malformed revision metadata: ${entry.label}`, async (): Promise<void> => {
      expectFailure(await runRevisionFixture({ inventory: entry.inventory }), metadataError);
    });
  }

  test("the 512-byte image boundary still requires trusted provenance", async (): Promise<void> => {
    expectFailure(
      await runRevisionFixture({ inventory: revisionInventory(["a".repeat(512)]) }),
      "An existing revision has untrusted declared image provenance",
    );
  });

  test("exactly 1,000 repeated revisions fit without redundant Git work", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({
      inventory: revisionInventory(Array<string>(1_000).fill(validImage)),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Verified source compatibility for 1000 preserved revisions\n");
    expect(argumentsFor(result, "git")).toHaveLength(6);
  });

  test("1,001 revisions fail closed before per-revision Git work", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({
      inventory: revisionInventory(Array<string>(1_001).fill(validImage)),
    });
    expectFailure(result, metadataError);
    expect(argumentsFor(result, "git")).toHaveLength(3);
  });

  test("one MiB of metadata is accepted but one extra byte is rejected before parsing", async (): Promise<void> => {
    const exact: RevisionFixtureResult = await runRevisionFixture({
      inventory: `[]${" ".repeat(1_048_574)}`,
    });
    expect(exact.code).toBe(0);
    expect(exact.stdout).toBe("Verified source compatibility for 0 preserved revisions\n");
    const over: RevisionFixtureResult = await runRevisionFixture({
      inventory: `[]${" ".repeat(1_048_575)}`,
    });
    expectFailure(over, [
      "Revision preservation preflight exceeded its metadata bound",
      "Revision preservation preflight could not inspect the configured service",
    ]);
    expect(argumentsFor(over, "timeout")).toHaveLength(5);
  }, 15_000);

  test("trailing metadata newlines cannot hide bytes beyond the capture limit", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({
      inventory: `[]${"\n".repeat(1_048_575)}`,
    });
    expectFailure(result, [
      "Revision preservation preflight exceeded its metadata bound",
      "Revision preservation preflight could not inspect the configured service",
    ]);
    expect(argumentsFor(result, "timeout")).toHaveLength(5);
  });

  test("cloud command failures remain fixed and redact provider diagnostics", async (): Promise<void> => {
    expectFailure(
      await runRevisionFixture({ inventory: validInventory, failGcloud: true }),
      "Revision preservation preflight could not inspect the configured service",
    );
  });

  const timeoutFailures: readonly {
    readonly target: NonNullable<RevisionFixtureOptions["timeoutTarget"]>;
    readonly error: string;
  }[] = [
    {
      target: "history",
      error: "Revision preservation preflight requires complete local Git history",
    },
    {
      target: "cloud",
      error: "Revision preservation preflight could not inspect the configured service",
    },
    {
      target: "capture",
      error: "Revision preservation preflight could not inspect the configured service",
    },
    { target: "metadata", error: metadataError },
    {
      target: "images",
      error: "Revision preservation preflight could not read declared image provenance",
    },
    { target: "source", error: sourceError },
    { target: "ancestry", error: "An existing revision is outside the supported source ancestry" },
  ];
  for (const entry of timeoutFailures) {
    test(`timeout at bounded ${entry.target} command cannot produce success`, async (): Promise<void> => {
      const result: RevisionFixtureResult = await runRevisionFixture({
        inventory: validInventory,
        timeoutTarget: entry.target,
      });
      expectFailure(result, entry.error);
    });
  }

  const missingTools: readonly NonNullable<RevisionFixtureOptions["missingTool"]>[] = [
    "gcloud",
    "git",
    "jq",
    "head",
    "timeout",
  ];
  for (const missingTool of missingTools) {
    test(`missing ${missingTool} cannot silently skip the guard`, async (): Promise<void> => {
      const result: RevisionFixtureResult = await runRevisionFixture({
        inventory: "[]",
        missingTool,
      });
      expectFailure(
        result,
        "Revision preservation preflight requires gcloud, git, head, jq, and timeout",
      );
      expect(result.calls).toEqual([]);
    });
  }

  const invalidConfiguration: readonly Readonly<Record<string, string>>[] = [
    { PROJECT_ID: PRIVATE_SENTINEL },
    { REGION: "us-central1/other" },
    { ARTIFACT_REPOSITORY: "../other" },
    { SERVICE: "murmur;delete" },
    { GITHUB_SHA: DEPLOY_HEAD.toUpperCase() },
    { GITHUB_SHA: "" },
  ];
  for (const environment of invalidConfiguration) {
    test(`invalid deployment configuration ${Object.keys(environment).join()} performs no external operation`, async (): Promise<void> => {
      const result: RevisionFixtureResult = await runRevisionFixture(
        { inventory: "[]" },
        environment,
      );
      expectFailure(result, "Revision preservation preflight has invalid deployment configuration");
      expect(result.calls).toEqual([]);
    });
  }
});
