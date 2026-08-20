import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type {
  CloseAgentInput,
  CloseAgentOutput,
  EndSessionInput,
  EndSessionOutput,
  GetAgentInput,
  GetAgentOutput,
  ListAgentsInput,
  ListAgentsOutput,
  MarkMessagesReadInput,
  MarkMessagesReadOutput,
  RegisterAgentInput,
  RegisterAgentOutput,
} from "../src/domain/contracts.js";
import type {
  SubmitFeedbackInput,
  SubmitFeedbackOutput,
} from "../src/domain/feedback-contracts.js";
import {
  AgentClient,
  BranchName,
  type Clock,
  Instant,
  RepositoryName,
} from "../src/domain/value-objects.js";
import type { E2eeHttpRemoteClientConfig } from "../src/e2ee/http-remote-client.js";
import { localE2eeStatus } from "../src/e2ee/local-commands.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { E2eeProxyRemoteClient } from "../src/e2ee/remote-client.js";
import type {
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
  E2eeCapabilityOutput,
  EncryptedInboxOutput,
  GetEncryptedMessagesInput,
  GetInboxSummaryInput,
  GetInboxSummaryOutput,
  PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastOutput,
  PublishAgentKeyBundleInput,
  PublishAgentKeyBundleOutput,
  PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedMessageInput,
  PutEncryptedMessageOutput,
  WaitForEncryptedMessagesInput,
  WaitForEncryptedMessagesOutput,
} from "../src/e2ee/wire-tools.js";
import { type E2eeProxyHandle, type E2eeProxyRuntime, main } from "../src/e2ee-proxy.js";

class NoopTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  public async start(): Promise<void> {}

  public async send(_message: JSONRPCMessage): Promise<void> {}

  public async close(): Promise<void> {
    const handler: (() => void) | undefined = this.onclose;
    if (handler !== undefined) handler();
  }
}

class FixedClock implements Clock {
  public now(): Instant {
    return Instant.parse("2026-08-10T20:00:00.000Z");
  }
}

class StartupRemote implements E2eeProxyRemoteClient {
  public closeCount: number = 0;

  public async capability(): Promise<E2eeCapabilityOutput> {
    return {
      caller_authority: "peer",
      max_ciphertext_bytes: 524_304,
      max_one_time_prekeys: 100,
      protocol: "murmur-e2ee-v1",
      state: "enforced",
      tenant_id: "00000000-0000-4000-8000-000000000010",
      wire_version: 1,
    };
  }

  public async registerAgent(_input: RegisterAgentInput): Promise<RegisterAgentOutput> {
    throw new Error("unexpected register call");
  }

  public async listAgents(_input: ListAgentsInput): Promise<ListAgentsOutput> {
    throw new Error("unexpected list call");
  }

  public async getAgent(_input: GetAgentInput): Promise<GetAgentOutput> {
    throw new Error("unexpected get agent call");
  }

  public async endSession(_input: EndSessionInput): Promise<EndSessionOutput> {
    throw new Error("unexpected end session call");
  }

  public async closeAgent(_input: CloseAgentInput): Promise<CloseAgentOutput> {
    throw new Error("unexpected close agent call");
  }

  public async submitFeedback(_input: SubmitFeedbackInput): Promise<SubmitFeedbackOutput> {
    throw new Error("unexpected feedback call");
  }

  public async publishAgentKeyBundle(
    _input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    throw new Error("unexpected publish call");
  }

  public async claimEncryptionPrekey(
    _input: ClaimEncryptionPrekeyInput,
  ): Promise<ClaimEncryptionPrekeyOutput> {
    throw new Error("unexpected claim call");
  }

  public async putEncryptedMessage(
    _input: PutEncryptedMessageInput,
  ): Promise<PutEncryptedMessageOutput> {
    throw new Error("unexpected put call");
  }

  public async getEncryptedMessages(
    _input: GetEncryptedMessagesInput,
  ): Promise<EncryptedInboxOutput> {
    throw new Error("unexpected read call");
  }

  public async waitForEncryptedMessages(
    _input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput> {
    throw new Error("unexpected wait call");
  }

  public async markMessagesRead(_input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    throw new Error("unexpected mark call");
  }

  public async prepareEncryptedBroadcast(
    _input: PrepareEncryptedBroadcastInput,
  ): Promise<PrepareEncryptedBroadcastOutput> {
    throw new Error("unexpected prepare call");
  }

  public async putEncryptedBroadcastDelivery(
    _input: PutEncryptedBroadcastDeliveryInput,
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    throw new Error("unexpected delivery call");
  }

  public async commitEncryptedBroadcast(
    _input: CommitEncryptedBroadcastInput,
  ): Promise<CommitEncryptedBroadcastOutput> {
    throw new Error("unexpected commit call");
  }

  public async cancelEncryptedBroadcast(
    _input: CancelEncryptedBroadcastInput,
  ): Promise<CancelEncryptedBroadcastOutput> {
    throw new Error("unexpected cancel call");
  }

  public async getInboxSummary(_input: GetInboxSummaryInput): Promise<GetInboxSummaryOutput> {
    throw new Error("unexpected summary call");
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

test("E2E proxy entrypoint validates entitlement, creates no key, and shuts down once", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-entry-"));
  const vaultPath: string = join(directory, "vault.sqlite");
  const remote: StartupRemote = new StartupRemote();
  const listeners: Map<NodeJS.Signals, () => void> = new Map<NodeJS.Signals, () => void>();
  const vaultHolder: { value: LocalE2eeVault | null } = { value: null };
  const captured: { value: E2eeHttpRemoteClientConfig | null } = { value: null };
  const runtime: E2eeProxyRuntime = {
    clock: new FixedClock(),
    connectRemote: async (config: E2eeHttpRemoteClientConfig): Promise<E2eeProxyRemoteClient> => {
      captured.value = config;
      return remote;
    },
    createTransport: (): Transport => new NoopTransport(),
    createVault: (path: string): LocalE2eeVault => {
      const created: LocalE2eeVault = new LocalE2eeVault(path, "linux");
      vaultHolder.value = created;
      return created;
    },
    detectBranchName: (): BranchName | null => BranchName.parse("feature/e2ee"),
    detectRepositoryName: (): RepositoryName | null => RepositoryName.parse("mattpatagon/murmur"),
    environment: { MURMUR_API_TOKEN: "test-token" },
    onSignal: (signal: NodeJS.Signals, listener: () => void): void => {
      listeners.set(signal, listener);
    },
  };
  try {
    const handle: E2eeProxyHandle = await main(
      ["--url", "https://api.example.test/mcp", "--client", "codex", "--vault-path", vaultPath],
      runtime,
    );
    if (captured.value === null) throw new Error("Expected the runtime to connect upstream");
    expect(captured.value).toEqual({
      branch: "feature/e2ee",
      client: "codex",
      endpoint: "https://api.example.test/mcp",
      repository: "mattpatagon/murmur",
      token: "test-token",
    });
    if (vaultHolder.value === null) throw new Error("Expected the runtime to create a local vault");
    expect(localE2eeStatus(vaultHolder.value)).toEqual({
      initialized: false,
      peer_count: 0,
      root_key_id: null,
    });
    expect(vaultHolder.value.settings.getActiveTenant()).toEqual({
      boundAt: "2026-08-10T20:00:00.000Z",
      tenantId: "00000000-0000-4000-8000-000000000010",
    });
    expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    const interrupt: (() => void) | undefined = listeners.get("SIGINT");
    const terminate: (() => void) | undefined = listeners.get("SIGTERM");
    if (interrupt === undefined || terminate === undefined) {
      throw new Error("Expected deterministic proxy signal handlers");
    }
    interrupt();
    terminate();
    await handle.shutdown();
    await handle.shutdown();
    expect(remote.closeCount).toBe(1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("E2E proxy rejects incomplete startup before opening a remote connection", async (): Promise<void> => {
  let connections: number = 0;
  const runtime: E2eeProxyRuntime = {
    clock: new FixedClock(),
    connectRemote: async (_config: E2eeHttpRemoteClientConfig): Promise<E2eeProxyRemoteClient> => {
      connections += 1;
      return new StartupRemote();
    },
    createTransport: (): Transport => new NoopTransport(),
    createVault: (path: string): LocalE2eeVault => new LocalE2eeVault(path, "linux"),
    detectBranchName: (): BranchName | null => null,
    detectRepositoryName: (): RepositoryName | null => null,
    environment: {},
    onSignal: (_signal: NodeJS.Signals, _listener: () => void): void => undefined,
  };
  await expect(main(["--url", "https://api.example.test/mcp"], runtime)).rejects.toThrow(
    "--client is required",
  );
  await expect(
    main(
      ["--url", "https://api.example.test/mcp", "--client", AgentClient.parse("codex").value],
      runtime,
    ),
  ).rejects.toThrow("MURMUR_API_TOKEN is required");
  expect(connections).toBe(0);
});
