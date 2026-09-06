import { describe, expect, test } from "bun:test";
import process from "node:process";

import {
  CUTOVER_SENTINEL,
  type CutoverCommand,
  type CutoverOptions,
  type CutoverResult,
  type CutoverStage,
  READY_REVISION,
  runCutoverFixture,
} from "./support/deploy-revision-cutover.js";

const enabled: boolean = process.env["MURMUR_TEST_DEPLOY_REVISIONS"] === "1";
if (enabled && process.platform !== "linux") {
  throw new Error("Revision cutover shell tests require the explicit Linux gate");
}

function expectFailure(result: CutoverResult, message: string): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${message}\n`);
  expect(result.stderr).not.toContain(CUTOVER_SENTINEL);
  expect(result.stderr).not.toContain(READY_REVISION);
}

function actualCalls(result: CutoverResult): CutoverCommand[] {
  return result.calls.filter((call: CutoverCommand): boolean => call.command !== "timeout");
}

const readyCall: CutoverCommand = {
  command: "gcloud",
  arguments: [
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
  ],
};
const trafficCall: CutoverCommand = {
  command: "gcloud",
  arguments: [
    "run",
    "services",
    "update-traffic",
    "murmur",
    "--project",
    "test-project",
    "--region",
    "us-central1",
    "--to-revisions",
    `${READY_REVISION}=100`,
    "--clear-tags",
    "--quiet",
  ],
};
const retainedCall: CutoverCommand = {
  command: "gcloud",
  arguments: [
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
  ],
};
const healthCall: CutoverCommand = {
  command: "curl",
  arguments: [
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    "https://murmur.example.test/health",
  ],
};

describe.skipIf(!enabled)("Linux non-destructive revision cutover", (): void => {
  test("false contraction cuts over the exact ready revision and clears tags without listing or deleting revisions", async (): Promise<void> => {
    const result: CutoverResult = await runCutoverFixture({
      revisionNames: [READY_REVISION, "murmur-old-retained"],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(actualCalls(result)).toEqual([readyCall, trafficCall, healthCall]);
    const bounded: CutoverCommand[] = result.calls.filter(
      (call: CutoverCommand): boolean => call.command === "timeout",
    );
    expect(bounded).toHaveLength(3);
    for (const call of bounded) {
      expect(call.arguments.slice(0, 2)).toEqual(["--signal=TERM", "--kill-after=1s"]);
      expect(call.arguments[2]).toMatch(/^(?:[1-9]|[12][0-9]|30)s$/u);
      expect(["gcloud", "curl"]).toContain(call.arguments[3] ?? "");
    }
  });

  test("true contraction requires the exact sole ready revision in the unfiltered two-name lookup", async (): Promise<void> => {
    const result: CutoverResult = await runCutoverFixture(
      {},
      { TENANT_CONTRACT_FINALIZE_REQUIRED: "true" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(actualCalls(result)).toEqual([readyCall, trafficCall, retainedCall, healthCall]);
  });

  test("latest-first and older-second inventory refuses contraction despite limit-before-filter behavior", async (): Promise<void> => {
    const result: CutoverResult = await runCutoverFixture(
      { revisionNames: [READY_REVISION, "murmur-old-retained"] },
      { TENANT_CONTRACT_FINALIZE_REQUIRED: "true" },
    );
    expectFailure(
      result,
      "Tenant contraction requires independently verified writer drainage; retained revisions were not deleted",
    );
    expect(actualCalls(result)).toEqual([readyCall, trafficCall, retainedCall]);
  });

  const unsupportedInventories: readonly {
    readonly label: string;
    readonly names: readonly string[];
  }[] = [
    { label: "empty", names: [] },
    { label: "duplicate latest", names: [READY_REVISION, READY_REVISION] },
    { label: "older only", names: ["murmur-old-retained"] },
    { label: "older first", names: ["murmur-old-retained", READY_REVISION] },
    { label: "foreign service", names: ["other-00042-safe"] },
    { label: "malformed name", names: [CUTOVER_SENTINEL] },
    { label: "whitespace", names: [" "] },
    { label: "control suffix", names: [`${READY_REVISION}\r`] },
    { label: "newline suffix", names: [`${READY_REVISION}\n`] },
    { label: "extra empty row", names: [READY_REVISION, ""] },
    { label: "extra newline row", names: [READY_REVISION, "\n"] },
    { label: "leading empty row", names: ["", READY_REVISION] },
  ];
  for (const inventory of unsupportedInventories) {
    test(`unsupported ${inventory.label} inventory fails closed before health verification`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture(
        { revisionNames: inventory.names },
        { TENANT_CONTRACT_FINALIZE_REQUIRED: "true" },
      );
      expectFailure(
        result,
        "Tenant contraction requires independently verified writer drainage; retained revisions were not deleted",
      );
      expect(actualCalls(result)).toEqual([readyCall, trafficCall, retainedCall]);
    });
  }

  test("a 63-character ready revision is retained exactly in the traffic target", async (): Promise<void> => {
    const readyRevision: string = `murmur-${"a".repeat(56)}`;
    const result: CutoverResult = await runCutoverFixture({ readyRevision });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(actualCalls(result)).toEqual([
      readyCall,
      {
        ...trafficCall,
        arguments: trafficCall.arguments.map((argument: string): string =>
          argument === `${READY_REVISION}=100` ? `${readyRevision}=100` : argument,
        ),
      },
      healthCall,
    ]);
  });

  const malformedReady: readonly string[] = [
    "",
    "other-00042-safe",
    "murmur-safe\nmurmur-other",
    "murmur-SAFE",
    "murmur-$(delete)",
    `murmur-${"a".repeat(57)}`,
    CUTOVER_SENTINEL,
  ];
  for (const readyRevision of malformedReady) {
    test(`malformed ready revision ${JSON.stringify(readyRevision)} stops before traffic updates`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture({ readyRevision });
      expectFailure(result, "Cloud Run did not report a valid ready revision for this service");
      expect(actualCalls(result)).toEqual([readyCall]);
    });
  }

  const invalidStates: readonly (string | undefined)[] = [
    undefined,
    "",
    "TRUE",
    "yes",
    CUTOVER_SENTINEL,
  ];
  for (const state of invalidStates) {
    test(`missing or invalid contraction state ${String(state)} performs no commands`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture(
        {},
        { TENANT_CONTRACT_FINALIZE_REQUIRED: state },
      );
      expectFailure(result, "Revision preservation requires an explicit tenant contraction state");
      expect(result.calls).toEqual([]);
    });
  }

  const failures: readonly {
    readonly stage: CutoverStage;
    readonly message: string;
    readonly preceding: readonly CutoverCommand[];
    readonly failing: CutoverCommand;
  }[] = [
    {
      stage: "ready",
      message: "Cloud Run ready revision lookup failed",
      preceding: [],
      failing: readyCall,
    },
    {
      stage: "traffic",
      message: "Cloud Run traffic cutover failed; revision definitions were preserved",
      preceding: [readyCall],
      failing: trafficCall,
    },
    {
      stage: "retained",
      message: "Cloud Run retained revision lookup failed; tenant contraction cannot proceed",
      preceding: [readyCall, trafficCall],
      failing: retainedCall,
    },
    {
      stage: "health",
      message: "Production health verification failed after traffic cutover",
      preceding: [readyCall, trafficCall, retainedCall],
      failing: healthCall,
    },
  ];
  for (const entry of failures) {
    test(`failed ${entry.stage} command is redacted and prevents later actions`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture(
        { failureAt: entry.stage },
        { TENANT_CONTRACT_FINALIZE_REQUIRED: "true" },
      );
      expectFailure(result, entry.message);
      expect(actualCalls(result)).toEqual([...entry.preceding, entry.failing]);
    });
    test(`timed-out ${entry.stage} command is redacted and prevents later actions`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture(
        { timeoutAt: entry.stage },
        { TENANT_CONTRACT_FINALIZE_REQUIRED: "true" },
      );
      expectFailure(result, entry.message);
      expect(actualCalls(result)).toEqual([...entry.preceding]);
    });
  }

  const missingTools: readonly NonNullable<CutoverOptions["missingTool"]>[] = [
    "gcloud",
    "curl",
    "timeout",
  ];
  for (const missingTool of missingTools) {
    test(`missing ${missingTool} fails instead of skipping preservation`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture({ missingTool });
      expectFailure(result, "Revision preservation requires gcloud, curl, and timeout");
      expect(result.calls).toEqual([]);
    });
  }

  const invalidConfiguration: readonly Readonly<Record<string, string>>[] = [
    { PROJECT_ID: CUTOVER_SENTINEL },
    { REGION: "us-central1/other" },
    { SERVICE: "murmur;delete" },
    { PRODUCTION_URL: "http://murmur.example.test" },
    { PRODUCTION_URL: "https://murmur.example.test/private" },
    { PRODUCTION_URL: "https://secret@murmur.example.test" },
  ];
  for (const environment of invalidConfiguration) {
    test(`invalid configuration ${Object.keys(environment).join()} performs no commands`, async (): Promise<void> => {
      const result: CutoverResult = await runCutoverFixture({}, environment);
      expectFailure(result, "Revision preservation has invalid deployment configuration");
      expect(result.calls).toEqual([]);
    });
  }
});
