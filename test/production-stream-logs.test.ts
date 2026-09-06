import { expect, test } from "bun:test";

import {
  ProductionStreamLogFailure,
  parseStreamLogResult,
  STREAM_LOG_MAX_BYTES,
  type StreamLogConfiguration,
  type StreamLogContext,
  type StreamLogResult,
  validateStreamLogConfiguration,
} from "../scripts/lib/production-stream-log-contracts.js";
import {
  type StreamApplicationLog,
  streamObservationArguments,
} from "../scripts/lib/production-stream-log-queries.js";
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
  START,
  timestamp,
} from "./support/production-stream-logs.js";

test("log preflight binds sole serving revision, exact registry/source/version and existing read access", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const context: StreamLogContext = await fixture.ready();
  expect(context).toEqual({
    ...CONFIG,
    schema_version: 1,
    revision: REVISION,
    version: CONFIG.expectedVersion,
    checkedAt: timestamp(0),
  });
  expect(fixture.calls).toHaveLength(3);
  for (const call of fixture.calls) {
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(call.arguments).toContain("--project");
    expect(call.arguments).not.toContain("--impersonate-service-account");
  }
  const access: (typeof fixture.calls)[number] | undefined = fixture.calls[2];
  if (access === undefined) throw new Error("Missing access command");
  expect(access.arguments).toContain("2");
  expect(access.arguments.join(" ")).not.toMatch(
    /textPayload|Authorization|spec\.containers\[\]\.env/u,
  );
  expect(access.arguments.join(" ")).toContain(`resource.labels.revision_name="${REVISION}"`);
});

test("same-session proof requires exact initial rotation and later successful replacement completion", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const context: StreamLogContext = await fixture.ready();
  const verified: Awaited<ReturnType<typeof verifyProductionStreamLogs>> =
    await verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture);
  expect(verified.application_rotation).toBe(true);
  expect(verified.same_session_reconnect).toBe(true);
  expect(verified.platform_5xx_absent_in_observed_window).toBe(true);
  expect(verified.revision).toBe(REVISION);
  expect(fixture.sleeps).toEqual([]);
  const filters: string[] = fixture.calls.flatMap(
    (call: (typeof fixture.calls)[number]): string[] =>
      call.arguments[0] === "logging" ? [call.arguments.join(" ")] : [],
  );
  expect(filters.some((filter: string): boolean => filter.includes(INITIAL_ID))).toBe(true);
  expect(filters.some((filter: string): boolean => filter.includes(REPLACEMENT_ID))).toBe(true);
  expect(
    filters.some(
      (filter: string): boolean =>
        filter.includes("run.googleapis.com%2Frequests") &&
        filter.includes("httpRequest.status>=500"),
    ),
  ).toBe(true);
});

test("eventual log arrival waits boundedly and never skips the ingestion grace or failure checks", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const context: StreamLogContext = await fixture.ready();
  fixture.elapsed = END;
  fixture.initialMisses = 2;
  await verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture);
  expect(fixture.sleeps).toHaveLength(8);
  expect(fixture.sleeps.every((milliseconds: number): boolean => milliseconds === 15_000)).toBe(
    true,
  );
  expect(fixture.elapsed).toBe(END + 120_000);
});

test("missing logs exhaust a finite polling budget instead of accepting absence as evidence", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const context: StreamLogContext = await fixture.ready();
  fixture.initial = [];
  await expect(
    verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
  ).rejects.toThrow(ProductionStreamLogFailure);
  expect(fixture.sleeps).toHaveLength(19);
  expect(fixture.calls.length).toBeLessThan(70);
});

for (const changes of [
  { expectedSha: "A".repeat(40) },
  { project: 'bad" OR true' },
  { service: "../murmur" },
  { region: "--format=json" },
  { repository: "other/repository" },
  { origin: "http://api.example.com" },
  { origin: "https://secret@api.example.com" },
  { origin: "https://api.example.com/mcp" },
  { origin: "https://api.example.com/?secret=private" },
  { expectedVersion: "private-sentinel" },
  { project: "murmur-project\n" },
  { service: "murmur\n" },
  { expectedSha: `${SHA}\n` },
  { region: "us-central1\n" },
  { repository: "application\n" },
  { origin: "https://api.example.com\n" },
]) {
  test(`unsafe log configuration rejects before subprocess execution: ${Object.keys(changes)[0]}`, async (): Promise<void> => {
    const fixture: LogFixture = new LogFixture();
    expect(
      (): StreamLogConfiguration => validateStreamLogConfiguration({ ...CONFIG, ...changes }),
    ).toThrow(ProductionStreamLogFailure);
    await expect(preflightProductionStreamLogs({ ...CONFIG, ...changes }, fixture)).rejects.toThrow(
      ProductionStreamLogFailure,
    );
    expect(fixture.calls).toEqual([]);
  });
}

for (const traffic of [
  [],
  [{ revisionName: REVISION, percent: 99 }],
  [{ revisionName: REVISION, percent: 100, tag: "old" }],
  [
    { revisionName: REVISION, percent: 100 },
    { revisionName: "murmur-old-abc", percent: 0 },
  ],
  [{ revisionName: "murmur-old-abc", percent: 100 }],
]) {
  test("preflight rejects missing, split, tagged or non-ready traffic", async (): Promise<void> => {
    const fixture: LogFixture = new LogFixture();
    fixture.service = {
      metadata: { name: "murmur" },
      status: { latestReadyRevisionName: REVISION, traffic },
    };
    await expect(preflightProductionStreamLogs(CONFIG, fixture)).rejects.toThrow(
      ProductionStreamLogFailure,
    );
  });
}

for (const image of [
  `${CONFIG.region}-docker.pkg.dev/foreign-project/application/murmur:${SHA}`,
  `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/foreign/murmur:${SHA}`,
  `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/${CONFIG.repository}/murmur:latest`,
  `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/${CONFIG.repository}/murmur:${SHA}@sha256:bad`,
  `${CONFIG.region}-docker.pkg.dev/${CONFIG.project}/${CONFIG.repository}/murmur:${SHA}\n`,
]) {
  test("preflight rejects untrusted or malformed declared image provenance", async (): Promise<void> => {
    const fixture: LogFixture = new LogFixture();
    fixture.image = { metadata: { name: REVISION }, spec: { containers: [{ image }] } };
    await expect(preflightProductionStreamLogs(CONFIG, fixture)).rejects.toThrow(
      ProductionStreamLogFailure,
    );
  });
}

test("release mismatch, missing command access and oversized metadata fail safely before the canary", async (): Promise<void> => {
  for (const fault of ["release", "command", "oversize", "deadline"]) {
    const fixture: LogFixture = new LogFixture();
    if (fault === "release")
      fixture.releaseValue = { revision: "b".repeat(40), version: CONFIG.expectedVersion };
    if (fault === "command") fixture.fail = true;
    if (fault === "oversize") fixture.oversize = true;
    if (fault === "deadline") fixture.perCallMs = 120_001;
    await expect(preflightProductionStreamLogs(CONFIG, fixture)).rejects.toThrow(
      "Production stream log verification failed",
    );
  }
});

for (const field of [
  "sessionHash",
  "initialRequestId",
  "replacementRequestId",
  "sameSession",
  "cleanupPassed",
  "streamClosed",
  "passed",
]) {
  test(`observer evidence fails closed when ${field} is missing or false`, async (): Promise<void> => {
    const fixture: LogFixture = new LogFixture();
    const context: StreamLogContext = await fixture.ready();
    const count: number = fixture.calls.length;
    await expect(
      verifyProductionStreamLogs(
        CONFIG,
        context,
        JSON.stringify({ ...result(), [field]: false }),
        fixture,
      ),
    ).rejects.toThrow(ProductionStreamLogFailure);
    expect(fixture.calls).toHaveLength(count);
  });
}

test("observer JSONL permits only bounded ordered progress followed by one final result", (): void => {
  const progress: string = JSON.stringify({
    event: "production-stream-progress",
    elapsedMilliseconds: 60_000,
  });
  const final: string = JSON.stringify(result());
  expect(parseStreamLogResult(`${progress}\n${final}\n`)).toEqual(result());
  for (const text of [
    `${final}\n${final}`,
    `${final}\n${progress}`,
    progress,
    `${progress}\n${progress}\n${final}`,
    `${JSON.stringify({ event: "unknown", raw: "private-sentinel" })}\n${final}`,
    " ".repeat(STREAM_LOG_MAX_BYTES + 1) + final,
  ]) {
    expect((): StreamLogResult => parseStreamLogResult(text)).toThrow(ProductionStreamLogFailure);
  }
});

test("untrusted log rows cannot impersonate the canary or conceal failed rotation", async (): Promise<void> => {
  const original: StreamApplicationLog = applicationLog(true);
  for (const changed of [
    {
      ...original,
      resource: {
        ...original.resource,
        labels: { ...original.resource.labels, revision_name: "murmur-other-abc" },
      },
    },
    { ...original, jsonPayload: { ...original.jsonPayload, session_hash: "x".repeat(22) } },
    { ...original, jsonPayload: { ...original.jsonPayload, request_id: REPLACEMENT_ID } },
    { ...original, jsonPayload: { ...original.jsonPayload, stream_rotated: false } },
    { ...original, jsonPayload: { ...original.jsonPayload, response_finish: "failed" } },
    { ...original, jsonPayload: { ...original.jsonPayload, duration_ms: 5_000 } },
    { ...original, jsonPayload: { ...original.jsonPayload, private: "private-sentinel" } },
  ]) {
    const fixture: LogFixture = new LogFixture();
    const context: StreamLogContext = await fixture.ready();
    fixture.initial = [changed];
    await expect(
      verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
    ).rejects.toThrow(ProductionStreamLogFailure);
  }
});

test("duplicate exact-request records and replacement before rotation are not accepted", async (): Promise<void> => {
  for (const duplicate of [true, false]) {
    const fixture: LogFixture = new LogFixture();
    const context: StreamLogContext = await fixture.ready();
    if (duplicate) fixture.initial = [applicationLog(true), applicationLog(true)];
    else fixture.replacement = [{ ...applicationLog(false), timestamp: timestamp(START) }];
    await expect(
      verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
    ).rejects.toThrow(ProductionStreamLogFailure);
  }
});

test("any platform 5xx rejects the window, including a 3600-second request without inspecting bodies", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const context: StreamLogContext = await fixture.ready();
  fixture.platform = [
    {
      timestamp: timestamp(END),
      resource: applicationLog(true).resource,
      httpRequest: { status: 504, latency: "3600.000000s" },
    },
  ];
  await expect(
    verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
  ).rejects.toThrow(ProductionStreamLogFailure);
  expect(fixture.sleeps).toEqual([]);
});

test("platform evidence ends before adversarial cleanup while application lookup keeps ingestion slack", async (): Promise<void> => {
  const fixture: LogFixture = new LogFixture();
  const context: StreamLogContext = await fixture.ready();
  const observed: StreamLogResult = result();
  const platform: string = streamObservationArguments(context, observed, "platform").join(" ");
  const application: string = streamObservationArguments(context, observed, "replacement").join(
    " ",
  );
  expect(platform).toContain(`timestamp<="${observed.endedAt}"`);
  expect(platform).not.toContain(`timestamp<="${timestamp(END + 30_000)}"`);
  expect(application).toContain(`timestamp<="${timestamp(END + 30_000)}"`);
});

test("post-observation revision changes and shorter real windows invalidate prior preflight evidence", async (): Promise<void> => {
  for (const fault of ["deployment", "window", "context", "same-id", "future"]) {
    const fixture: LogFixture = new LogFixture();
    const context: StreamLogContext = await fixture.ready();
    let output: unknown = result();
    let contextValue: unknown = context;
    if (fault === "deployment")
      fixture.releaseValue = { revision: "b".repeat(40), version: CONFIG.expectedVersion };
    if (fault === "window") output = { ...result(), endedAt: timestamp(END - 1) };
    if (fault === "context") contextValue = { ...context, project: "foreign-project" };
    if (fault === "same-id") output = { ...result(), replacementRequestId: INITIAL_ID };
    if (fault === "future") output = { ...result(), endedAt: timestamp(END + 500_000) };
    await expect(
      verifyProductionStreamLogs(CONFIG, contextValue, JSON.stringify(output), fixture),
    ).rejects.toThrow(ProductionStreamLogFailure);
  }
});

test("metadata arrays are bounded and never treated as successfully truncated inventories", async (): Promise<void> => {
  const initial: StreamApplicationLog = applicationLog(true);
  const metadata: {
    readonly timestamp: string;
    readonly resource: StreamApplicationLog["resource"];
  } = {
    timestamp: initial.timestamp,
    resource: initial.resource,
  };
  const fixture: LogFixture = new LogFixture();
  fixture.access = [metadata, metadata, metadata];
  await expect(preflightProductionStreamLogs(CONFIG, fixture)).rejects.toThrow(
    ProductionStreamLogFailure,
  );
  fixture.access = [];
  const context: StreamLogContext = await fixture.ready();
  fixture.platform = [{ unexpected: "private-sentinel" }];
  await expect(
    verifyProductionStreamLogs(CONFIG, context, JSON.stringify(result()), fixture),
  ).rejects.toThrow(ProductionStreamLogFailure);
});

test("stream evidence follows canonical four-part versions without accepting leading zeroes or trailing controls", (): void => {
  for (const expectedVersion of ["1.2.3", "01.2.3.4", "1.02.3.4", "1.2.3.4\n", "1.2.3.4-private"]) {
    expect(
      (): StreamLogConfiguration => validateStreamLogConfiguration({ ...CONFIG, expectedVersion }),
    ).toThrow(ProductionStreamLogFailure);
    expect(
      (): StreamLogResult => parseStreamLogResult(JSON.stringify({ ...result(), expectedVersion })),
    ).toThrow(ProductionStreamLogFailure);
  }
  const expectedVersion: string = "1234567890.2.3.4";
  expect(validateStreamLogConfiguration({ ...CONFIG, expectedVersion }).expectedVersion).toBe(
    expectedVersion,
  );
});
