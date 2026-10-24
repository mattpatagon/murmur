import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { BranchName, type Clock, Instant, RepositoryName } from "../src/domain/value-objects.js";
import type { E2eeHttpRemoteClientConfig } from "../src/e2ee/http-remote-client.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { E2eeProxyRemoteClient } from "../src/e2ee/remote-client.js";
import type { E2eeCapabilityOutput } from "../src/e2ee/wire-tools.js";
import { type E2eeProxyHandle, type E2eeProxyRuntime, main } from "../src/e2ee-proxy.js";
import { MemoryE2eeBackend, MemoryE2eeRemote } from "./support/e2ee-memory-remote.js";

const ARGUMENTS: readonly string[] = [
  "--url",
  "https://proxy.example.test/mcp",
  "--client",
  "codex",
  "--vault-path",
  ":memory:",
];
const CLOCK: Clock = { now: (): Instant => Instant.parse("2026-08-10T20:00:00.000Z") };

class RuntimeRemote extends MemoryE2eeRemote {
  public closeCount: number = 0;
  public failure: Error | null = null;
  public closeFailure: Error | null = null;

  public override async capability(): Promise<E2eeCapabilityOutput> {
    if (this.failure !== null) throw this.failure;
    return await super.capability();
  }

  public override async close(): Promise<void> {
    this.closeCount += 1;
    await super.close();
    if (this.closeFailure !== null) throw this.closeFailure;
  }
}

class RuntimeTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  public startCount: number = 0;
  public closeCount: number = 0;
  public failure: Error | null = null;

  public async start(): Promise<void> {
    this.startCount += 1;
    if (this.failure !== null) throw this.failure;
  }

  public async send(_message: JSONRPCMessage): Promise<void> {}

  public async close(): Promise<void> {
    this.closeCount += 1;
    if (this.onclose !== undefined) this.onclose();
  }
}

class RuntimeVault extends LocalE2eeVault {
  public closeCount: number = 0;

  public constructor() {
    super(":memory:", "linux");
  }

  public override close(): void {
    this.closeCount += 1;
    super.close();
  }
}

type RuntimeHarness = {
  readonly connections: E2eeHttpRemoteClientConfig[];
  readonly remote: RuntimeRemote;
  readonly runtime: E2eeProxyRuntime;
  readonly signals: NodeJS.Signals[];
  readonly transport: RuntimeTransport;
  readonly vaultPaths: string[];
  readonly vaults: RuntimeVault[];
};

function harness(createVault?: (path: string) => RuntimeVault): RuntimeHarness {
  const connections: E2eeHttpRemoteClientConfig[] = [];
  const remote: RuntimeRemote = new RuntimeRemote(new MemoryE2eeBackend());
  const transport: RuntimeTransport = new RuntimeTransport();
  const signals: NodeJS.Signals[] = [];
  const vaultPaths: string[] = [];
  const vaults: RuntimeVault[] = [];
  const runtime: E2eeProxyRuntime = {
    clock: CLOCK,
    connectRemote: async (config: E2eeHttpRemoteClientConfig): Promise<E2eeProxyRemoteClient> => {
      connections.push(config);
      return remote;
    },
    createTransport: (): Transport => transport,
    createVault: (path: string): LocalE2eeVault => {
      vaultPaths.push(path);
      const vault: RuntimeVault =
        createVault === undefined ? new RuntimeVault() : createVault(path);
      vaults.push(vault);
      return vault;
    },
    detectBranchName: (): BranchName => BranchName.parse("detected-branch"),
    detectRepositoryName: (): RepositoryName => RepositoryName.parse("detected/repository"),
    environment: {
      HOME: tmpdir(),
      LOCALAPPDATA: tmpdir(),
      MURMUR_API_TOKEN: "test-token",
      USERPROFILE: tmpdir(),
      XDG_DATA_HOME: tmpdir(),
    },
    onSignal: (signal: NodeJS.Signals, _listener: () => void): void => {
      signals.push(signal);
    },
  };
  return { connections, remote, runtime, signals, transport, vaultPaths, vaults };
}

function releaseVaults(fixture: RuntimeHarness): void {
  for (const vault of fixture.vaults) {
    if (vault.closeCount === 0) vault.close();
  }
}

// Value: protects=explicit CLI context overrides detected upstream context;
// fails_when=branch or repository options are ignored or resources close twice;
// why_new=existing entrypoint tests use detected context only; seam=none;
// no_claim=TOFU send behavior is covered by encryption contracts, not this startup test.
test("explicit proxy context and trust option start with the selected private vault", async (): Promise<void> => {
  const fixture: RuntimeHarness = harness();
  let handle: E2eeProxyHandle | null = null;
  try {
    handle = await main(
      [
        ...ARGUMENTS,
        "--branch",
        "explicit/security-fix",
        "--repository",
        "explicit/repository",
        "--trust-on-first-use",
      ],
      fixture.runtime,
    );
    expect(fixture.connections).toEqual([
      {
        branch: "explicit/security-fix",
        client: "codex",
        endpoint: "https://proxy.example.test/mcp",
        repository: "explicit/repository",
        token: "test-token",
      },
    ]);
    expect(fixture.vaultPaths).toEqual([":memory:"]);
    expect(fixture.transport.startCount).toBe(1);
    expect(fixture.signals).toEqual(["SIGINT", "SIGTERM"]);
    await Promise.all([handle.shutdown(), handle.shutdown()]);
    expect(fixture.remote.closeCount).toBe(1);
    expect(fixture.transport.closeCount).toBe(1);
  } finally {
    if (handle !== null) await handle.shutdown();
    releaseVaults(fixture);
  }
});

// Value: protects=missing or misplaced CLI values fail before acquiring resources;
// fails_when=an option consumes the next option or starts an incomplete connection;
// why_new=existing entrypoint tests cover missing client and token only; seam=none;
// no_claim=argument-boundary contract only, no network connection.
test.each(["--branch", "--client", "--repository", "--url", "--vault-path"])(
  "%s rejects a missing value and another option as its value",
  async (option: string): Promise<void> => {
    const fixture: RuntimeHarness = harness();
    for (const supplied of [[option], [option, "--trust-on-first-use"]]) {
      await expect(main(supplied, fixture.runtime)).rejects.toThrow(`${option} requires a value`);
    }
    expect(fixture.connections).toEqual([]);
    expect(fixture.vaultPaths).toEqual([]);
    expect(fixture.signals).toEqual([]);
  },
);

test("proxy rejects a missing endpoint and unknown options before connecting", async (): Promise<void> => {
  const fixture: RuntimeHarness = harness();
  await expect(main(["--client", "codex"], fixture.runtime)).rejects.toThrow("--url is required");
  await expect(main([...ARGUMENTS, "--unexpected"], fixture.runtime)).rejects.toThrow(
    "Unknown E2E proxy option",
  );
  expect(fixture.connections).toEqual([]);
  expect(fixture.vaultPaths).toEqual([]);
});

// Value: protects=partial startup releases upstream and preserves the original failure;
// fails_when=remote close is skipped or replaces the capability/vault startup failure;
// why_new=existing entrypoint tests only cover successful resource acquisition; seam=none;
// no_claim=failures are injected at the existing runtime boundary.
test.each(["capability", "vault"])(
  "%s startup failure closes upstream even when its cleanup also rejects",
  async (phase: string): Promise<void> => {
    const original: Error = new Error("original startup failure");
    const fixture: RuntimeHarness = harness((): RuntimeVault => {
      throw original;
    });
    if (phase === "capability") fixture.remote.failure = original;
    fixture.remote.closeFailure = new Error("secondary cleanup failure");
    await expect(main(ARGUMENTS, fixture.runtime)).rejects.toBe(original);
    expect(fixture.remote.closeCount).toBe(1);
    expect(fixture.transport.startCount).toBe(0);
    expect(fixture.signals).toEqual([]);
    expect(fixture.vaultPaths).toHaveLength(phase === "vault" ? 1 : 0);
  },
);

test("tenant binding failure closes the opened vault and upstream before transport startup", async (): Promise<void> => {
  const fixture: RuntimeHarness = harness((): RuntimeVault => {
    const vault: RuntimeVault = new RuntimeVault();
    vault.settings.bindActiveTenant(
      "00000000-0000-4000-8000-000000000099",
      CLOCK.now().toISOString(),
    );
    return vault;
  });
  try {
    await expect(main(ARGUMENTS, fixture.runtime)).rejects.toThrow("bound to another tenant");
    expect(fixture.vaults.map((vault: RuntimeVault): number => vault.closeCount)).toEqual([1]);
    expect(fixture.remote.closeCount).toBe(1);
    expect(fixture.transport.startCount).toBe(0);
    expect(fixture.signals).toEqual([]);
  } finally {
    releaseVaults(fixture);
  }
});

// Value: protects=transport startup failure cleans both owned resources without masking its cause;
// fails_when=application cleanup is skipped or cleanup failure replaces transport failure;
// why_new=existing entrypoint tests only connect a working transport; seam=none;
// no_claim=transport start failure is injected, no stdio or public service.
test("transport startup preserves its failure after failed upstream cleanup and closes the vault", async (): Promise<void> => {
  const fixture: RuntimeHarness = harness();
  const original: Error = new Error("transport startup failure");
  fixture.transport.failure = original;
  fixture.remote.closeFailure = new Error("secondary remote cleanup failure");
  try {
    await expect(main(ARGUMENTS, fixture.runtime)).rejects.toBe(original);
    expect(fixture.remote.closeCount).toBe(1);
    expect(fixture.vaults.map((vault: RuntimeVault): number => vault.closeCount)).toEqual([1]);
    expect(fixture.transport.closeCount).toBe(1);
    expect(fixture.signals).toEqual([]);
  } finally {
    releaseVaults(fixture);
  }
});
