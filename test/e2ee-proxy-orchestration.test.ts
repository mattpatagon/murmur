import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SenderAuthority } from "../src/domain/orchestration.js";
import type { Clock, Instant } from "../src/domain/value-objects.js";
import {
  AgentClient,
  BranchName,
  Instant as InstantValue,
  RepositoryName,
} from "../src/domain/value-objects.js";
import {
  orchestrationClaimedProvenance,
  ordinaryClaimedProvenance,
} from "../src/e2ee/claimed-provenance.js";
import { trustPeerFingerprint } from "../src/e2ee/local-commands.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { StoredRootKey } from "../src/e2ee/local-vault-rows.js";
import type {
  ProxyAskOrchestratorOutput,
  ProxyInboxOutput,
  ProxySendMessageOutput,
} from "../src/e2ee/proxy-contracts.js";
import { E2eeProxyService } from "../src/e2ee/proxy-service.js";
import type {
  ClaimOrchestratorPrekeyInput,
  ClaimOrchestratorPrekeyOutput,
} from "../src/e2ee/wire-orchestration.js";
import type {
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  E2eeCapabilityOutput,
  PutEncryptedMessageInput,
} from "../src/e2ee/wire-tools.js";
import { PutEncryptedMessageInputSchema } from "../src/e2ee/wire-tools.js";
import type {
  EffectiveOrchestratorDto,
  GetOrchestratorInput,
  GetOrchestratorOutput,
} from "../src/hosted/orchestration-contracts.js";
import {
  type CapturedRemoteCall,
  MemoryE2eeBackend,
  MemoryE2eeRemote,
} from "./support/e2ee-memory-remote.js";

const NOW_TEXT: string = "2026-08-10T20:00:00.000Z";
const TENANT_ID: string = "00000000-0000-4000-8000-000000000010";
const POLICY_ID: string = "00000000-0000-4000-8000-000000000099";
const OTHER_POLICY_ID: string = "00000000-0000-4000-8000-000000000098";
const PEER_ID: string = "machine-a:codex:repo-a:peer";
const ORCHESTRATOR_ID: string = "machine-b:codex:repo-b:orchestrator";
const QUESTION: string = "encrypted-orchestration-question-🔐";
const REPLY: string = "encrypted-orchestration-reply-🔏";
const ORCHESTRATOR: EffectiveOrchestratorDto = {
  agent_id: ORCHESTRATOR_ID,
  policy_id: POLICY_ID,
  scope: {
    machine: null,
    personal_id: null,
    repository: "example/repo-a",
    scope_kind: "organization",
  },
};

class FixedClock implements Clock {
  public now(): Instant {
    return InstantValue.parse(NOW_TEXT);
  }
}

class OrchestrationRemote extends MemoryE2eeRemote {
  readonly #authority: SenderAuthority;
  readonly #backend: MemoryE2eeBackend;
  #orchestrator: EffectiveOrchestratorDto | null;

  public constructor(backend: MemoryE2eeBackend, authority: SenderAuthority) {
    super(backend);
    this.#authority = authority;
    this.#backend = backend;
    this.#orchestrator = authority === "peer" ? ORCHESTRATOR : null;
  }

  public setOrchestrator(orchestrator: EffectiveOrchestratorDto | null): void {
    this.#orchestrator = orchestrator;
  }

  public override async capability(): Promise<E2eeCapabilityOutput> {
    return { ...(await super.capability()), caller_authority: this.#authority };
  }

  public override async claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
  ): Promise<ClaimEncryptionPrekeyOutput> {
    this.#backend.captures.push({ input: structuredClone(input), tool: "claim_encryption_prekey" });
    return this.#backend.claim(input, ordinaryClaimedProvenance(this.#authority));
  }

  public async getOrchestrator(input: GetOrchestratorInput): Promise<GetOrchestratorOutput> {
    this.#backend.captures.push({ input: structuredClone(input), tool: "get_orchestrator" });
    return {
      caller_authority: this.#authority,
      orchestrator: this.#orchestrator,
    };
  }

  public async claimOrchestratorPrekey(
    input: ClaimOrchestratorPrekeyInput,
  ): Promise<ClaimOrchestratorPrekeyOutput> {
    this.#backend.captures.push({
      input: structuredClone(input),
      tool: "claim_orchestrator_prekey",
    });
    const orchestrator: EffectiveOrchestratorDto | null = this.#orchestrator;
    if (orchestrator === null) throw new Error("No active orchestrator is configured");
    return {
      claim: this.#backend.claim(
        {
          context: input.context,
          recipient_id: orchestrator.agent_id,
          sender_id: input.sender_id,
          ...(input.session_key === undefined ? {} : { session_key: input.session_key }),
        },
        orchestrationClaimedProvenance(orchestrator.policy_id),
      ),
      orchestrator,
    };
  }
}

function service(
  vault: LocalE2eeVault,
  remote: OrchestrationRemote,
  repository: string,
): E2eeProxyService {
  return new E2eeProxyService({
    branchName: BranchName.parse("feature/e2e-orchestration"),
    client: AgentClient.parse("codex"),
    clock: new FixedClock(),
    remote,
    repositoryName: RepositoryName.parse(repository),
    trustOnFirstUse: false,
    vault,
  });
}

function root(vault: LocalE2eeVault): StoredRootKey {
  const stored: StoredRootKey | null = vault.keys.getRoot();
  if (stored === null) throw new Error("Expected a registered local root key");
  return stored;
}

test("orchestrator requests and replies remain encrypted with signed server-issued provenance", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-orchestration-"));
  const backend: MemoryE2eeBackend = new MemoryE2eeBackend();
  const peerVault: LocalE2eeVault = new LocalE2eeVault(join(directory, "peer.sqlite"), "linux");
  const bossVault: LocalE2eeVault = new LocalE2eeVault(join(directory, "boss.sqlite"), "linux");
  const peerRemote: OrchestrationRemote = new OrchestrationRemote(backend, "peer");
  const peer: E2eeProxyService = service(peerVault, peerRemote, "example/repo-a");
  const boss: E2eeProxyService = service(
    bossVault,
    new OrchestrationRemote(backend, "orchestrator"),
    "example/repo-b",
  );
  try {
    await peer.registerAgent({ agent_id: PEER_ID });
    await boss.registerAgent({ agent_id: ORCHESTRATOR_ID });
    trustPeerFingerprint(
      peerVault,
      { agentId: ORCHESTRATOR_ID, rootKeyId: root(bossVault).rootKeyId, tenantId: TENANT_ID },
      InstantValue.parse(NOW_TEXT),
    );
    trustPeerFingerprint(
      bossVault,
      { agentId: PEER_ID, rootKeyId: root(peerVault).rootKeyId, tenantId: TENANT_ID },
      InstantValue.parse(NOW_TEXT),
    );

    const asked: ProxyAskOrchestratorOutput = await peer.askOrchestrator({
      content: QUESTION,
      idempotency_key: "orchestrator-question-1",
      sender_id: PEER_ID,
    });
    expect(asked.orchestrator).toEqual(ORCHESTRATOR);
    expect(asked.message.encryption).toMatchObject({
      message_kind: "orchestration_request",
      orchestrator_policy_id: POLICY_ID,
      sender_authority: "peer",
    });
    peerRemote.setOrchestrator(null);
    const retried: ProxyAskOrchestratorOutput = await peer.askOrchestrator({
      content: QUESTION,
      idempotency_key: "orchestrator-question-1",
      sender_id: PEER_ID,
    });
    expect(retried.duplicate).toBe(true);
    expect(retried.orchestrator).toEqual(ORCHESTRATOR);
    expect(
      backend.captures.filter(
        (capture: CapturedRemoteCall): boolean => capture.tool === "get_orchestrator",
      ),
    ).toHaveLength(1);
    const bossInbox: ProxyInboxOutput = await boss.getMessages({
      after_sequence: 0,
      agent_id: ORCHESTRATOR_ID,
      limit: 100,
      unread_only: false,
    });
    expect(bossInbox.messages[0]).toMatchObject({
      content: QUESTION,
      encryption: asked.message.encryption,
    });

    const replied: ProxySendMessageOutput = await boss.sendMessage({
      content: REPLY,
      idempotency_key: "orchestrator-reply-1",
      recipient_id: PEER_ID,
      sender_id: ORCHESTRATOR_ID,
      thread_id: asked.message.thread_id,
    });
    expect(replied.message.encryption).toMatchObject({
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "orchestrator",
    });
    const peerInbox: ProxyInboxOutput = await peer.getMessages({
      after_sequence: 0,
      agent_id: PEER_ID,
      limit: 100,
      unread_only: false,
    });
    expect(peerInbox.messages[0]).toMatchObject({
      content: REPLY,
      encryption: replied.message.encryption,
    });

    const putCapture: CapturedRemoteCall | undefined = backend.captures.find(
      (capture: CapturedRemoteCall): boolean => capture.tool === "put_encrypted_message",
    );
    if (putCapture === undefined) throw new Error("Expected an encrypted orchestration upload");
    const put: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse(putCapture.input);
    expect((): unknown =>
      PutEncryptedMessageInputSchema.parse({
        ...put,
        envelope: {
          ...put.envelope,
          header: { ...put.envelope.header, sender_authority: "orchestrator" },
        },
      }),
    ).toThrow();
    const relabelled: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse({
      ...put,
      envelope: {
        ...put.envelope,
        header: { ...put.envelope.header, orchestrator_policy_id: OTHER_POLICY_ID },
      },
    });
    await expect(backend.put(relabelled)).rejects.toThrow();

    const captures: string = JSON.stringify(backend.captures);
    expect(captures).not.toContain(QUESTION);
    expect(captures).not.toContain(REPLY);
  } finally {
    await Promise.allSettled([peer.close(), boss.close()]);
    rmSync(directory, { force: true, recursive: true });
  }
});
