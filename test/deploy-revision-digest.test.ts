import { describe, expect, test } from "bun:test";
import process from "node:process";

import {
  DIGEST_IMAGE,
  IMAGE_PREFIX,
  PRESERVED_DIGEST,
  PRESERVED_SOURCE,
  PRIVATE_SENTINEL,
  REGISTRY_PACKAGE,
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
const inventory: string = revisionInventory([DIGEST_IMAGE]);
const tagRecord: { readonly name: string; readonly version: string } = {
  name: `${REGISTRY_PACKAGE}/tags/${PRESERVED_SOURCE}`,
  version: `${REGISTRY_PACKAGE}/versions/${PRESERVED_DIGEST}`,
};
const sourceMetadataError: string =
  "Revision preservation preflight received unsupported or excessive source metadata";
const sourceTagError: string = "An existing revision lacks one unambiguous supported source tag";
const bindingError: string = "An existing revision source tag does not match its deployed digest";

function expectFailure(result: RevisionFixtureResult, error: string): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${error}\n`);
  expect(result.stderr).not.toContain(PRIVATE_SENTINEL);
  expect(result.stderr).not.toContain(IMAGE_PREFIX);
}

function registryCalls(result: RevisionFixtureResult): RevisionCommand[] {
  return result.calls.filter(
    (call: RevisionCommand): boolean =>
      call.command === "gcloud" && call.arguments[0] === "artifacts",
  );
}

describe.skipIf(!enabled)("Linux digest-only preserved revision provenance", (): void => {
  test("resolves one exact source tag, binds the deployed digest, and deduplicates identical images", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({
      inventory: revisionInventory([DIGEST_IMAGE, DIGEST_IMAGE]),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Verified source compatibility for 2 preserved revisions\n");
    expect(registryCalls(result).map((call: RevisionCommand): string[] => call.arguments)).toEqual([
      [
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
      ],
      [
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
      ],
    ]);
    expect(
      result.calls.filter(
        (call: RevisionCommand): boolean =>
          call.command === "git" && call.arguments[0] === "merge-base",
      ),
    ).toHaveLength(2);
  });

  test("a non-source alias does not replace or obscure the one full source SHA", async (): Promise<void> => {
    const result: RevisionFixtureResult = await runRevisionFixture({
      inventory,
      registryTags: JSON.stringify([
        tagRecord,
        { ...tagRecord, name: `${REGISTRY_PACKAGE}/tags/latest` },
      ]),
    });
    expect(result.code).toBe(0);
    expect(registryCalls(result)).toHaveLength(2);
  });

  for (const registryTags of [
    "[]",
    JSON.stringify([{ ...tagRecord, name: `${REGISTRY_PACKAGE}/tags/latest` }]),
    JSON.stringify([
      tagRecord,
      { ...tagRecord, name: `${REGISTRY_PACKAGE}/tags/${"d".repeat(40)}` },
    ]),
  ]) {
    test("missing or ambiguous full source tags fail closed", async (): Promise<void> => {
      const result: RevisionFixtureResult = await runRevisionFixture({ inventory, registryTags });
      expectFailure(result, sourceTagError);
      expect(registryCalls(result)).toHaveLength(1);
    });
  }

  for (const registryTags of [
    PRIVATE_SENTINEL,
    "{}",
    "[null]",
    "[]\n[]",
    JSON.stringify([tagRecord, tagRecord]),
    JSON.stringify([{ ...tagRecord, extra: PRIVATE_SENTINEL }]),
    JSON.stringify([{ ...tagRecord, name: 42 }]),
    JSON.stringify([{ ...tagRecord, name: `${tagRecord.name}\n` }]),
    JSON.stringify([
      { ...tagRecord, name: tagRecord.name.replace("test-project", "other-project") },
    ]),
    JSON.stringify([{ ...tagRecord, version: tagRecord.version.replace("runtime", "other") }]),
    JSON.stringify([
      { ...tagRecord, version: `${REGISTRY_PACKAGE}/versions/sha256:${"d".repeat(64)}` },
    ]),
    JSON.stringify(Array<object>(1001).fill(tagRecord)),
  ]) {
    test("invalid, foreign, duplicate, mismatched or capped source metadata is rejected", async (): Promise<void> => {
      expectFailure(await runRevisionFixture({ inventory, registryTags }), sourceMetadataError);
    });
  }

  test("the complete 1000-tag boundary passes while 1001 distinct tags fail", async (): Promise<void> => {
    const aliases: { readonly name: string; readonly version: string }[] = Array.from(
      { length: 999 },
      (_value: unknown, index: number): { readonly name: string; readonly version: string } => ({
        name: `${REGISTRY_PACKAGE}/tags/alias-${index}`,
        version: tagRecord.version,
      }),
    );
    const registryTags: string = JSON.stringify([tagRecord, ...aliases]);
    expect((await runRevisionFixture({ inventory, registryTags })).code).toBe(0);
    expectFailure(
      await runRevisionFixture({
        inventory,
        registryTags: JSON.stringify([
          tagRecord,
          ...aliases,
          { ...tagRecord, name: `${REGISTRY_PACKAGE}/tags/last-alias` },
        ]),
      }),
      sourceMetadataError,
    );
  });

  test("oversized source metadata including trailing whitespace fails safely", async (): Promise<void> => {
    expectFailure(
      await runRevisionFixture({
        inventory,
        registryTags: JSON.stringify([tagRecord]).padEnd(1_048_577, "\n"),
      }),
      sourceMetadataError,
    );
  });

  for (const registryImage of [
    PRIVATE_SENTINEL,
    "{}",
    "null",
    "{}\n{}",
    JSON.stringify({ image_summary: { digest: PRESERVED_DIGEST } }),
    JSON.stringify({
      image_summary: { digest: `sha256:${"d".repeat(64)}`, fully_qualified_digest: DIGEST_IMAGE },
    }),
    JSON.stringify({
      image_summary: { digest: PRESERVED_DIGEST, fully_qualified_digest: `${DIGEST_IMAGE}extra` },
    }),
    JSON.stringify({
      image_summary: {
        digest: PRESERVED_DIGEST,
        fully_qualified_digest: DIGEST_IMAGE,
        extra: PRIVATE_SENTINEL,
      },
    }),
  ]) {
    test("retargeted or malformed exact-tag digest resolution cannot establish provenance", async (): Promise<void> => {
      expectFailure(await runRevisionFixture({ inventory, registryImage }), bindingError);
    });
  }

  test("oversized exact-tag binding metadata fails safely", async (): Promise<void> => {
    expectFailure(
      await runRevisionFixture({
        inventory,
        registryImage: JSON.stringify({
          image_summary: { digest: PRESERVED_DIGEST, fully_qualified_digest: DIGEST_IMAGE },
        }).padEnd(1_048_577, "\n"),
      }),
      bindingError,
    );
  });

  for (const failure of ["tags", "image"]) {
    test(`registry ${failure} access and timeout failures remain safe`, async (): Promise<void> => {
      const failRegistry: NonNullable<RevisionFixtureOptions["failRegistry"]> =
        failure === "tags" ? "tags" : "image";
      const timeoutTarget: NonNullable<RevisionFixtureOptions["timeoutTarget"]> =
        failure === "tags" ? "registry-tags" : "registry-image";
      const error: string =
        failure === "tags"
          ? "Revision preservation preflight could not inspect image source tags"
          : "Revision preservation preflight could not verify image source binding";
      expectFailure(await runRevisionFixture({ inventory, failRegistry }), error);
      expectFailure(await runRevisionFixture({ inventory, timeoutTarget }), error);
    });
  }

  for (const ancestryFailure of ["floor", "head"]) {
    test(`digest lookup still enforces ${ancestryFailure} ancestry`, async (): Promise<void> => {
      expectFailure(
        await runRevisionFixture({
          inventory,
          ancestryFailure: ancestryFailure === "floor" ? "floor" : "head",
        }),
        "An existing revision is outside the supported source ancestry",
      );
    });
  }

  test("digest source must exist as a complete-history commit", async (): Promise<void> => {
    expectFailure(
      await runRevisionFixture({ inventory, missingCommit: PRESERVED_SOURCE }),
      "An existing revision source is absent from complete local Git history",
    );
    expectFailure(
      await runRevisionFixture({ inventory, nonCommit: PRESERVED_SOURCE }),
      "An existing revision source is absent from complete local Git history",
    );
  });
});
