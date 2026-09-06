import { expect, test } from "bun:test";

import {
  ProductionStreamLogFailure,
  STREAM_LOG_MAX_BYTES,
  type StreamLogContext,
} from "../scripts/lib/production-stream-log-contracts.js";
import {
  preflightProductionStreamLogs,
  verifyProductionStreamLogs,
} from "../scripts/lib/production-stream-log-verifier.js";
import {
  applicationLog,
  CONFIG,
  END,
  INITIAL_ID,
  LogFixture,
  REPLACEMENT_ID,
  REVISION,
  result,
  SHA,
  timestamp,
} from "./support/production-stream-logs.js";

const IMAGE: string = `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/${CONFIG.repository}/${CONFIG.service}`;
const DIGEST: string = `sha256:${"b".repeat(64)}`;
const OTHER_DIGEST: string = `sha256:${"c".repeat(64)}`;
const FAILURE: string = "Production stream log verification failed";

function sourceArtifact(digest: string = DIGEST): unknown {
  return { image_summary: { digest, fully_qualified_digest: `${IMAGE}@${digest}` } };
}

function digestFixture(image: string = `${IMAGE}@${DIGEST}`): LogFixture {
  const fixture: LogFixture = new LogFixture();
  fixture.image = { metadata: { name: REVISION }, spec: { containers: [{ image }] } };
  fixture.artifact = sourceArtifact();
  return fixture;
}

function artifactCalls(fixture: LogFixture): typeof fixture.calls {
  return fixture.calls.filter(
    (call: (typeof fixture.calls)[number]): boolean => call.arguments[0] === "artifacts",
  );
}

function observationCalls(fixture: LogFixture): typeof fixture.calls {
  return fixture.calls.filter(
    (call: (typeof fixture.calls)[number]): boolean =>
      call.arguments[0] === "logging" &&
      call.arguments.some(
        (argument: string): boolean =>
          argument.includes(INITIAL_ID) || argument.includes(REPLACEMENT_ID),
      ),
  );
}

test("digest-only preflight proves the exact source tag through bounded authenticated artifact metadata", async (): Promise<void> => {
  const fixture: LogFixture = digestFixture();
  const context: StreamLogContext = await preflightProductionStreamLogs(CONFIG, fixture);
  expect(context.revision).toBe(REVISION);
  expect(context.expectedSha).toBe(SHA);
  expect(context.version).toBe(CONFIG.expectedVersion);
  expect(
    fixture.calls.map(
      (call: (typeof fixture.calls)[number]): string | undefined => call.arguments[0],
    ),
  ).toEqual(["run", "run", "artifacts", "logging"]);
  expect(fixture.releaseCalls).toBe(1);
  const calls: typeof fixture.calls = artifactCalls(fixture);
  expect(calls).toHaveLength(1);
  const call: (typeof calls)[number] | undefined = calls[0];
  if (call === undefined) throw new Error("Missing source provenance lookup");
  expect(call.arguments).toEqual([
    "artifacts",
    "docker",
    "images",
    "describe",
    `${IMAGE}:${SHA}`,
    "--project",
    CONFIG.project,
    "--format",
    "json(image_summary.digest,image_summary.fully_qualified_digest)",
    "--quiet",
    "--verbosity=error",
  ]);
  expect(call.timeoutMs).toBeGreaterThan(0);
  expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
  expect(call.arguments.join(" ")).not.toMatch(/list|impersonate|access-token|Authorization|iam/u);
});

test("digest provenance is read afresh at preflight and both post-window deployment checks", async (): Promise<void> => {
  const fixture: LogFixture = digestFixture();
  const context: StreamLogContext = await fixture.ready();
  const verified: Awaited<ReturnType<typeof verifyProductionStreamLogs>> =
    await verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture);
  expect(verified.application_rotation).toBe(true);
  expect(verified.same_session_reconnect).toBe(true);
  expect(verified.platform_5xx_absent_in_observed_window).toBe(true);
  expect(verified.revision).toBe(REVISION);
  expect(artifactCalls(fixture)).toHaveLength(3);
  expect(fixture.releaseCalls).toBe(3);
  expect(observationCalls(fixture)).toHaveLength(2);
  expect(fixture.sleeps).toEqual([]);
  for (const call of fixture.calls) {
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
  }
});

for (const image of [`${IMAGE}:${SHA}`, `${IMAGE}:${SHA}@${DIGEST}`]) {
  test("existing exact source tag and tag-plus-digest proofs retain their original path", async (): Promise<void> => {
    const fixture: LogFixture = digestFixture(image);
    fixture.artifactFailure = true;
    const context: StreamLogContext = await fixture.ready();
    expect(fixture.calls).toHaveLength(3);
    await verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture);
    expect(artifactCalls(fixture)).toEqual([]);
    expect(fixture.releaseCalls).toBe(3);
  });
}

const INVALID_ARTIFACTS: readonly { readonly name: string; readonly value: unknown }[] = [
  { name: "null", value: null },
  { name: "empty object", value: {} },
  { name: "ambiguous inventory", value: [sourceArtifact(), sourceArtifact()] },
  { name: "missing full image", value: { image_summary: { digest: DIGEST } } },
  { name: "retargeted source tag", value: sourceArtifact(OTHER_DIGEST) },
  {
    name: "digest and full identity disagreement",
    value: {
      image_summary: { digest: DIGEST, fully_qualified_digest: `${IMAGE}@${OTHER_DIGEST}` },
    },
  },
  {
    name: "wrong region",
    value: {
      image_summary: {
        digest: DIGEST,
        fully_qualified_digest: `europe-west1-docker.pkg.dev/${CONFIG.project}/${CONFIG.repository}/${CONFIG.service}@${DIGEST}`,
      },
    },
  },
  {
    name: "wrong project",
    value: {
      image_summary: {
        digest: DIGEST,
        fully_qualified_digest: `${CONFIG.region}-docker.pkg.dev/foreign-project/${CONFIG.repository}/${CONFIG.service}@${DIGEST}`,
      },
    },
  },
  {
    name: "wrong repository",
    value: {
      image_summary: {
        digest: DIGEST,
        fully_qualified_digest: `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/foreign/${CONFIG.service}@${DIGEST}`,
      },
    },
  },
  {
    name: "wrong service",
    value: {
      image_summary: { digest: DIGEST, fully_qualified_digest: `${IMAGE}-foreign@${DIGEST}` },
    },
  },
  { name: "uppercase digest", value: sourceArtifact(`sha256:${"B".repeat(64)}`) },
  { name: "short digest", value: sourceArtifact(`sha256:${"b".repeat(63)}`) },
  { name: "digest trailing newline", value: sourceArtifact(`${DIGEST}\n`) },
  {
    name: "tagged noncanonical full identity",
    value: {
      image_summary: { digest: DIGEST, fully_qualified_digest: `${IMAGE}:${SHA}@${DIGEST}` },
    },
  },
  {
    name: "full identity trailing newline",
    value: { image_summary: { digest: DIGEST, fully_qualified_digest: `${IMAGE}@${DIGEST}\n` } },
  },
  {
    name: "unrequested metadata",
    value: {
      image_summary: {
        digest: DIGEST,
        fully_qualified_digest: `${IMAGE}@${DIGEST}`,
        private: "private-artifact-sentinel",
      },
    },
  },
];

for (const scenario of INVALID_ARTIFACTS) {
  test(`digest provenance rejects ${scenario.name} before health or log access`, async (): Promise<void> => {
    const fixture: LogFixture = digestFixture();
    fixture.artifact = scenario.value;
    await expect(preflightProductionStreamLogs(CONFIG, fixture)).rejects.toThrow(FAILURE);
    expect(artifactCalls(fixture)).toHaveLength(1);
    expect(fixture.releaseCalls).toBe(0);
    expect(
      fixture.calls.some(
        (call: (typeof fixture.calls)[number]): boolean => call.arguments[0] === "logging",
      ),
    ).toBe(false);
  });
}

for (const image of [
  `${IMAGE}@sha256:${"b".repeat(63)}`,
  `${IMAGE}@sha256:${"B".repeat(64)}`,
  `${IMAGE}@${DIGEST}\n`,
  `${IMAGE}-foreign@${DIGEST}`,
  `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/foreign/${CONFIG.service}@${DIGEST}`,
  `${IMAGE}:${"c".repeat(40)}@${DIGEST}`,
]) {
  test("malformed or out-of-scope digest images cannot initiate source-tag resolution", async (): Promise<void> => {
    const fixture: LogFixture = digestFixture(image);
    await expect(preflightProductionStreamLogs(CONFIG, fixture)).rejects.toThrow(FAILURE);
    expect(artifactCalls(fixture)).toEqual([]);
    expect(fixture.releaseCalls).toBe(0);
  });
}

for (const fault of ["access", "invalid-json", "multiple-json", "oversized", "deadline"]) {
  test(`artifact ${fault} failure stays bounded and exposes only the safe error`, async (): Promise<void> => {
    const fixture: LogFixture = digestFixture();
    if (fault === "access") fixture.artifactFailure = true;
    if (fault === "invalid-json") fixture.artifactReplies.push("private-invalid-json-sentinel");
    if (fault === "multiple-json")
      fixture.artifactReplies.push(
        `${JSON.stringify(sourceArtifact())}\n${JSON.stringify(sourceArtifact())}`,
      );
    if (fault === "oversized") fixture.artifactReplies.push(" ".repeat(STREAM_LOG_MAX_BYTES + 1));
    if (fault === "deadline") fixture.artifactMilliseconds = 120_001;
    let failure: unknown = null;
    try {
      await preflightProductionStreamLogs(CONFIG, fixture);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProductionStreamLogFailure);
    expect(failure instanceof Error ? failure.message : "").toBe(FAILURE);
    expect(artifactCalls(fixture)).toHaveLength(1);
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.releaseCalls).toBe(0);
    expect(fixture.sleeps).toEqual([]);
  });
}

for (const point of ["before logs", "after logs"]) {
  test(`source-tag retargeting ${point} invalidates a previously successful digest preflight`, async (): Promise<void> => {
    const fixture: LogFixture = digestFixture();
    const context: StreamLogContext = await fixture.ready();
    if (point === "after logs") fixture.artifactReplies.push(JSON.stringify(sourceArtifact()));
    fixture.artifactReplies.push(JSON.stringify(sourceArtifact(OTHER_DIGEST)));
    await expect(
      verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
    ).rejects.toThrow(FAILURE);
    expect(artifactCalls(fixture)).toHaveLength(point === "after logs" ? 3 : 2);
    expect(observationCalls(fixture)).toHaveLength(point === "after logs" ? 2 : 0);
    expect(fixture.releaseCalls).toBe(point === "after logs" ? 2 : 1);
  });
}

for (const fault of ["source", "version", "traffic", "platform"]) {
  test(`digest matching never bypasses the existing ${fault} verification`, async (): Promise<void> => {
    const fixture: LogFixture = digestFixture();
    const context: StreamLogContext = await fixture.ready();
    if (fault === "source")
      fixture.releaseValue = { revision: "c".repeat(40), version: CONFIG.expectedVersion };
    if (fault === "version") fixture.releaseValue = { revision: SHA, version: "0.13.1.0" };
    if (fault === "traffic")
      fixture.service = {
        metadata: { name: CONFIG.service },
        status: {
          latestReadyRevisionName: REVISION,
          traffic: [{ revisionName: REVISION, percent: 99 }],
        },
      };
    if (fault === "platform")
      fixture.platform = [
        {
          timestamp: timestamp(END),
          resource: applicationLog(true).resource,
          httpRequest: { status: 500 },
        },
      ];
    await expect(
      verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
    ).rejects.toThrow(FAILURE);
    expect(artifactCalls(fixture)).toHaveLength(fault === "traffic" ? 1 : 2);
  });
}
