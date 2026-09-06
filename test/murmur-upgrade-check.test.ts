import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import packageMetadata from "../package.json" with { type: "json" };
import {
  type CheckForUpgradesOutput,
  CheckForUpgradesOutputSchema,
  compareMurmurVersions,
  createUpgradeCheckOutput,
} from "../src/domain/upgrade-contracts.js";
import { type HttpServerConfig, parseHttpServerConfig } from "../src/http/http-config.js";
import { createHttpRequestHandler, type McpRequestHandler } from "../src/http/http-router.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import {
  createMurmurUpgradeChecker,
  type MurmurUpgradeChecker,
} from "../src/mcp/murmur-upgrade-checker.js";
import {
  createDefaultHttpObservability,
  type HttpObservability,
  type RequestObservation,
} from "../src/observability/request-observation.js";

const CHECKED_AT: Date = new Date("2026-08-31T21:30:00.000Z");
const LATEST_REVISION: string = "a".repeat(40);

type FetchCall = {
  readonly init: RequestInit;
  readonly url: string;
};

class FetchStub {
  readonly #responses: Response[];
  public readonly calls: FetchCall[] = [];
  public readonly fetch: (url: string, init: RequestInit) => Promise<Response> = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    this.calls.push({ init, url });
    const response: Response | undefined = this.#responses.shift();
    if (response === undefined) throw new Error("Unexpected fetch call");
    return response;
  };

  public constructor(responses: readonly Response[]) {
    this.#responses = [...responses];
  }
}

function releaseResponse(
  version: string = "0.10.2.0",
  revision: string = LATEST_REVISION,
): Response {
  return new Response(JSON.stringify({ revision, version }), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status: 200,
  });
}

function checkerWith(
  stub: FetchStub,
  currentVersion: string = "0.10.1.0",
  now: () => Date = (): Date => CHECKED_AT,
): MurmurUpgradeChecker {
  return createMurmurUpgradeChecker({
    currentVersion,
    fetch: stub.fetch,
    now,
  });
}

test("four-part Murmur versions compare component by component", (): void => {
  expect(compareMurmurVersions("0.10.1.9", "0.10.2.0")).toBe(-1);
  expect(compareMurmurVersions("1.0.0.0", "0.99.99.99")).toBe(1);
  expect(compareMurmurVersions("2.3.4.5", "2.3.4.5")).toBe(0);
  expect((): number => compareMurmurVersions("1.2.3", "1.2.3.4")).toThrow();
  expect((): number => compareMurmurVersions("999999999999999999999999.0.0.0", "1.0.0.0")).toThrow(
    "too large",
  );
});

test("upgrade output distinguishes available, current, and ahead versions", (): void => {
  const available: CheckForUpgradesOutput = createUpgradeCheckOutput(
    "0.10.1.0",
    "0.10.2.0",
    LATEST_REVISION,
    CHECKED_AT,
  );
  const current: CheckForUpgradesOutput = createUpgradeCheckOutput(
    "0.10.2.0",
    "0.10.2.0",
    LATEST_REVISION,
    CHECKED_AT,
  );
  const ahead: CheckForUpgradesOutput = createUpgradeCheckOutput(
    "0.11.0.0",
    "0.10.2.0",
    LATEST_REVISION,
    CHECKED_AT,
  );
  expect(available).toMatchObject({ status: "update_available", update_available: true });
  expect(current).toMatchObject({ status: "up_to_date", update_available: false });
  expect(ahead).toMatchObject({ status: "ahead", update_available: false });
  expect(available.upgrade_steps).toHaveLength(3);
  expect(available.upgrade_steps[0]).toMatchObject({
    command: `bun install --global 'https://api.usemurmur.dev/downloads/murmur-0.10.2.0-${LATEST_REVISION}.tgz'`,
  });
  const setupStep: CheckForUpgradesOutput["upgrade_steps"][number] | undefined =
    available.upgrade_steps[1];
  const restartStep: CheckForUpgradesOutput["upgrade_steps"][number] | undefined =
    available.upgrade_steps[2];
  if (setupStep === undefined || restartStep === undefined) {
    throw new Error("Upgrade instructions were incomplete");
  }
  expect(setupStep.command).toBeNull();
  expect(setupStep.description).toContain("exact setup command");
  expect(setupStep.description).toContain("--url");
  expect(setupStep.description).toContain("--vault-path");
  expect(restartStep.description).toContain("Restart");
  expect(restartStep.description).toContain("Conductor");
});

test("upgrade checker validates and caches official release metadata", async (): Promise<void> => {
  const stub: FetchStub = new FetchStub([releaseResponse()]);
  const checker: MurmurUpgradeChecker = checkerWith(stub);
  const first: CheckForUpgradesOutput = await checker.checkForUpgrades();
  const second: CheckForUpgradesOutput = await checker.checkForUpgrades();

  expect(first).toEqual(second);
  expect(CheckForUpgradesOutputSchema.parse(first)).toMatchObject({
    checked_at: CHECKED_AT.toISOString(),
    current_version: "0.10.1.0",
    latest_revision: LATEST_REVISION,
    latest_version: "0.10.2.0",
    status: "update_available",
    update_available: true,
  });
  expect(stub.calls).toHaveLength(1);
  const releaseCall: FetchCall | undefined = stub.calls[0];
  if (releaseCall === undefined) throw new Error("Expected a release metadata request");
  expect(releaseCall.url).toBe("https://api.usemurmur.dev/version");
  for (const call of stub.calls) {
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  }
});

test("concurrent upgrade checks share one bounded upstream lookup", async (): Promise<void> => {
  const stub: FetchStub = new FetchStub([releaseResponse()]);
  const checker: MurmurUpgradeChecker = checkerWith(stub);
  const outputs: CheckForUpgradesOutput[] = await Promise.all([
    checker.checkForUpgrades(),
    checker.checkForUpgrades(),
    checker.checkForUpgrades(),
  ]);
  expect(outputs[0]).toEqual(outputs[1]);
  expect(outputs[1]).toEqual(outputs[2]);
  expect(stub.calls).toHaveLength(1);
});

test("expired upgrade cache refreshes against a new exact revision", async (): Promise<void> => {
  const nextRevision: string = "b".repeat(40);
  const stub: FetchStub = new FetchStub([
    releaseResponse(),
    releaseResponse("0.10.3.0", nextRevision),
  ]);
  let timestamp: number = CHECKED_AT.getTime();
  const checker: MurmurUpgradeChecker = createMurmurUpgradeChecker({
    cacheTtlMs: 100,
    currentVersion: "0.10.1.0",
    fetch: stub.fetch,
    now: (): Date => new Date(timestamp),
  });
  expect((await checker.checkForUpgrades()).latest_revision).toBe(LATEST_REVISION);
  timestamp += 101;
  expect((await checker.checkForUpgrades()).latest_revision).toBe(nextRevision);
  expect(stub.calls).toHaveLength(2);
});

test("upgrade checker converts untrusted upstream failures to one safe error", async (): Promise<void> => {
  const invalidRelease: FetchStub = new FetchStub([releaseResponse("0.10.2.0", "not-a-revision")]);
  await expect(checkerWith(invalidRelease).checkForUpgrades()).rejects.toThrow(
    "Murmur could not check for upgrades right now",
  );

  const oversizedRelease: FetchStub = new FetchStub([
    new Response("x".repeat(1_025), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  ]);
  await expect(checkerWith(oversizedRelease).checkForUpgrades()).rejects.toThrow(
    "Murmur could not check for upgrades right now",
  );

  const invalidVersion: FetchStub = new FetchStub([releaseResponse("latest")]);
  await expect(checkerWith(invalidVersion).checkForUpgrades()).rejects.toThrow(
    "Murmur could not check for upgrades right now",
  );

  const rejected: FetchStub = new FetchStub([new Response("denied", { status: 403 })]);
  await expect(checkerWith(rejected).checkForUpgrades()).rejects.toThrow(
    "Murmur could not check for upgrades right now",
  );
});

test("failed upgrade checks use a short cooldown before retrying upstream", async (): Promise<void> => {
  const stub: FetchStub = new FetchStub([
    new Response("unavailable", { status: 503 }),
    releaseResponse(),
  ]);
  let timestamp: number = CHECKED_AT.getTime();
  const checker: MurmurUpgradeChecker = createMurmurUpgradeChecker({
    currentVersion: "0.10.1.0",
    fetch: stub.fetch,
    now: (): Date => new Date(timestamp),
  });
  await expect(checker.checkForUpgrades()).rejects.toThrow(
    "Murmur could not check for upgrades right now",
  );
  await expect(checker.checkForUpgrades()).rejects.toThrow(
    "Murmur could not check for upgrades right now",
  );
  expect(stub.calls).toHaveLength(1);
  timestamp += 30_001;
  expect((await checker.checkForUpgrades()).latest_revision).toBe(LATEST_REVISION);
  expect(stub.calls).toHaveLength(2);
});

test("public version route validates its revision and exposes bounded release metadata", async (): Promise<void> => {
  const configured: HttpServerConfig = parseHttpServerConfig({
    MURMUR_RELEASE_REVISION: LATEST_REVISION,
  });
  expect(configured.releaseMetadata).toEqual({
    revision: LATEST_REVISION,
    version: packageMetadata.version,
  });
  expect(parseHttpServerConfig({}).releaseMetadata).toBeNull();
  expect(
    (): HttpServerConfig => parseHttpServerConfig({ MURMUR_RELEASE_REVISION: "main" }),
  ).toThrow();

  const observability: HttpObservability = createDefaultHttpObservability({
    MURMUR_LOG_LEVEL: "off",
  });
  const mcpHandler: McpRequestHandler = async (
    _request: Request,
    _observation: RequestObservation,
  ): Promise<Response> => new Response(null, { status: 204 });
  try {
    const handler: (request: Request) => Promise<Response> = createHttpRequestHandler(
      observability,
      mcpHandler,
      null,
      configured.releaseMetadata,
    );
    const response: Response = await handler(new Request("https://api.usemurmur.dev/version"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(configured.releaseMetadata);

    const rejected: Response = await handler(
      new Request("https://api.usemurmur.dev/version", { method: "POST" }),
    );
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("GET");

    const unavailable: (request: Request) => Promise<Response> = createHttpRequestHandler(
      observability,
      mcpHandler,
    );
    const unavailableResponse: Response = await unavailable(
      new Request("https://api.usemurmur.dev/version"),
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({ error: "Release metadata unavailable" });
  } finally {
    await observability.shutdown();
  }
});

test("standard MCP application exposes and validates the upgrade tool", async (): Promise<void> => {
  const output: CheckForUpgradesOutput = createUpgradeCheckOutput(
    "0.10.1.0",
    "0.10.2.0",
    LATEST_REVISION,
    CHECKED_AT,
  );
  const checker: MurmurUpgradeChecker = {
    checkForUpgrades: async (): Promise<CheckForUpgradesOutput> => output,
  };
  const application: MurmurApplication = new MurmurApplication({
    branchName: null,
    client: null,
    repositoryName: null,
    store: null,
    upgradeChecker: checker,
  });
  const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
  const client: Client = new Client(
    { name: "upgrade-check-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await application.server.connect(transports[1]);
    await client.connect(transports[0]);
    const listed: ListToolsResult = await client.listTools();
    const tool: ListToolsResult["tools"][number] | undefined = listed.tools.find(
      (candidate: ListToolsResult["tools"][number]): boolean =>
        candidate.name === "check_for_upgrades",
    );
    if (tool === undefined || tool.annotations === undefined) {
      throw new Error("Upgrade tool was not exposed");
    }
    expect(tool.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      readOnlyHint: true,
    });

    const raw: unknown = await client.callTool({ arguments: {}, name: "check_for_upgrades" });
    const result: CallToolResult = CallToolResultSchema.parse(raw);
    expect(CheckForUpgradesOutputSchema.parse(result.structuredContent)).toEqual(output);

    const invalidRaw: unknown = await client.callTool({
      arguments: { unexpected: true },
      name: "check_for_upgrades",
    });
    const invalid: CallToolResult = CallToolResultSchema.parse(invalidRaw);
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await application.close();
  }
});
