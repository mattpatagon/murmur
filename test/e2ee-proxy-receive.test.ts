import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../src/domain/contracts.js";
import { type Clock, Instant } from "../src/domain/value-objects.js";
import {
  type AgentKeyCertificate,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createSigningKeyPair,
  rootKeyId,
} from "../src/e2ee/certificates.js";
import { encryptEnvelope } from "../src/e2ee/envelope.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { CachedMessage, PeerPin, StoredPrekey } from "../src/e2ee/local-vault-rows.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeRandom,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";
import { type LocalPublishedIdentity, publishLocalIdentity } from "../src/e2ee/proxy-identity.js";
import {
  markEncryptedMessagesRead,
  type ReceiveEncryptedMessagesResult,
  receiveEncryptedMessages,
  type VerifiedDecryptedMessage,
  type WaitForDecryptedMessagesResult,
  waitForDecryptedMessages,
} from "../src/e2ee/proxy-receive.js";
import type { E2eeRemoteClient } from "../src/e2ee/remote-client.js";
import { envelopeToDto, parseEnvelopeDto, signingChainToDto } from "../src/e2ee/wire-contracts.js";
import type {
  AcknowledgeEncryptedMessagesOutput,
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
  E2eeCapabilityOutput,
  EncryptedInboxOutput,
  EncryptedMessageDto,
  EncryptedMessageReadReceiptDto,
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
const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const NOW: Instant = Instant.parse("2026-08-10T18:00:00.000Z");
class FixedTestClock implements Clock {
  public now(): Instant {
    return NOW;
  }
}
function bytes(length: number, start: number): Uint8Array {
  const output: Uint8Array = new Uint8Array(length);
  for (let index: number = 0; index < output.byteLength; index += 1) {
    output[index] = (start + index) % 256;
  }
  return output;
}
class FixedRandom implements EnvelopeRandom {
  readonly #pair: BoxKeyPair;
  public constructor(pair: BoxKeyPair) {
    this.#pair = pair;
  }
  public boxKeyPair(): BoxKeyPair {
    return { privateKey: this.#pair.privateKey.slice(), publicKey: this.#pair.publicKey.slice() };
  }
  public bytes(length: number): Uint8Array {
    return bytes(length, 211);
  }
}
class ReceiveRemote implements E2eeRemoteClient {
  #inbox: EncryptedInboxOutput = { agent_id: "recipient", inbox_version: 0, messages: [] };
  public markCalls: number = 0;
  public markFailure: Error | null = null;
  public markUpdated: number | null = null;

  public setMessage(message: EncryptedMessageDto): void {
    this.#inbox = {
      agent_id: "recipient",
      inbox_version: message.tenant_sequence,
      messages: [message],
    };
  }
  public setMessages(messages: readonly EncryptedMessageDto[]): void {
    this.#inbox = { agent_id: "recipient", inbox_version: 2, messages };
  }
  public async capability(): Promise<E2eeCapabilityOutput> {
    return {
      caller_authority: "peer",
      max_ciphertext_bytes: 512 * 1024 + 16,
      max_one_time_prekeys: 100,
      protocol: "murmur-e2ee-v1",
      state: "enforced",
      tenant_id: TENANT_ID,
      wire_version: 1,
    };
  }
  public async publishAgentKeyBundle(
    input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    return {
      agent_id: input.agent_id,
      fallback_prekey_id: input.bundle.fallback_prekey.prekey_id,
      one_time_prekey_count: input.bundle.one_time_prekeys.length,
      published_at: NOW.toISOString(),
      root_key_id: input.bundle.root_key_id,
    };
  }
  public async getEncryptedMessages(
    _input: GetEncryptedMessagesInput,
  ): Promise<EncryptedInboxOutput> {
    return this.#inbox;
  }

  public async claimEncryptionPrekey(
    _input: ClaimEncryptionPrekeyInput,
  ): Promise<ClaimEncryptionPrekeyOutput> {
    throw new Error("Unused fake method");
  }
  public async putEncryptedMessage(
    _input: PutEncryptedMessageInput,
  ): Promise<PutEncryptedMessageOutput> {
    throw new Error("Unused fake method");
  }
  public async waitForEncryptedMessages(
    input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput> {
    return {
      agent_id: input.agent_id,
      messages: this.#inbox.messages,
      timed_out: this.#inbox.messages.length === 0,
    };
  }
  public async markMessagesRead(input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    this.markCalls += 1;
    if (this.markFailure !== null) throw this.markFailure;
    return { read_at: NOW.toISOString(), updated: input.message_ids.length };
  }
  public async acknowledgeMessages(
    input: MarkMessagesReadInput,
  ): Promise<AcknowledgeEncryptedMessagesOutput> {
    this.markCalls += 1;
    if (this.markFailure !== null) throw this.markFailure;
    return {
      receipts: input.message_ids.map(
        (message_id: string): EncryptedMessageReadReceiptDto => ({
          message_id,
          read_at: NOW.toISOString(),
        }),
      ),
      updated: this.markUpdated === null ? input.message_ids.length : this.markUpdated,
    };
  }
  public async prepareEncryptedBroadcast(
    _input: PrepareEncryptedBroadcastInput,
  ): Promise<PrepareEncryptedBroadcastOutput> {
    throw new Error("Unused fake method");
  }
  public async putEncryptedBroadcastDelivery(
    _input: PutEncryptedBroadcastDeliveryInput,
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    throw new Error("Unused fake method");
  }
  public async commitEncryptedBroadcast(
    _input: CommitEncryptedBroadcastInput,
  ): Promise<CommitEncryptedBroadcastOutput> {
    throw new Error("Unused fake method");
  }
  public async cancelEncryptedBroadcast(
    _input: CancelEncryptedBroadcastInput,
  ): Promise<CancelEncryptedBroadcastOutput> {
    throw new Error("Unused fake method");
  }
  public async getInboxSummary(_input: GetInboxSummaryInput): Promise<GetInboxSummaryOutput> {
    throw new Error("Unused fake method");
  }
  public async close(): Promise<void> {}
}

async function senderCertificate(
  root: SigningKeyPair,
  agent: SigningKeyPair,
): Promise<AgentKeyCertificate> {
  return createAgentKeyCertificate(
    {
      agentId: "sender",
      createdAt: "2026-08-10T17:00:00.000Z",
      expiresAt: "2026-11-08T17:00:00.000Z",
      rootKeyId: await rootKeyId(root.publicKey),
      signingKeyId: await agentSigningKeyId(agent.publicKey),
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
}

async function encryptedMessage(
  identity: LocalPublishedIdentity,
  prekey: StoredPrekey,
  senderRoot: SigningKeyPair,
  senderAgent: SigningKeyPair,
  sender: AgentKeyCertificate,
): Promise<EncryptedMessageDto> {
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    {
      branchName: "feature/e2ee",
      broadcastId: null,
      client: "codex",
      createdAt: "2026-08-10T17:30:00.000Z",
      expiresAt: "2026-09-09T17:00:00.000Z",
      idempotencyKey: "receive-1",
      messageId: "22222222-2222-4222-8222-222222222222",
      messageKind: "message",
      orchestratorPolicyId: null,
      pairCounter: 1,
      recipientAgentKeyId: identity.agent.certificate.signingKeyId,
      recipientId: "recipient",
      recipientPrekeyClass: prekey.certificate.prekeyClass,
      recipientPrekeyId: prekey.certificate.prekeyId,
      recipientRootKeyId: identity.root.rootKeyId,
      repositoryName: "owner/repository",
      senderAgentKeyId: sender.signingKeyId,
      senderAuthority: "peer",
      senderId: "sender",
      senderRootKeyId: sender.rootKeyId,
      tenantId: TENANT_ID,
      threadId: "33333333-3333-4333-8333-333333333333",
    },
    "received plaintext sentinel",
    senderAgent.privateKey,
    prekey.certificate.prekeyPublicKey,
    new FixedRandom(await createBoxKeyPair(bytes(32, 161))),
  );
  return {
    envelope: envelopeToDto(envelope),
    read_at: null,
    sender_chain: signingChainToDto(senderRoot.publicKey, sender),
    tenant_sequence: 1,
  };
}

test("encrypted inbox reads acknowledge only after decrypting and retain replay cache", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-proxy-receive-"));
  const path: string = join(directory, "vault.sqlite");
  const firstVault: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  const secondVault: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  try {
    const remote: ReceiveRemote = new ReceiveRemote();
    const identity: LocalPublishedIdentity = await publishLocalIdentity(
      firstVault,
      remote,
      "recipient",
      NOW,
    );
    const prekey: StoredPrekey | undefined = identity.oneTimePrekeys[0];
    if (prekey === undefined) throw new Error("Expected recipient one-time prekey");
    const senderRoot: SigningKeyPair = await createSigningKeyPair(bytes(32, 1));
    const senderAgent: SigningKeyPair = await createSigningKeyPair(bytes(32, 33));
    const sender: AgentKeyCertificate = await senderCertificate(senderRoot, senderAgent);
    const pin: PeerPin = {
      agentId: "sender",
      publicKey: senderRoot.publicKey,
      rootKeyId: sender.rootKeyId,
      tenantId: TENANT_ID,
      verificationMode: "strict",
      verifiedAt: NOW.toISOString(),
    };
    await firstVault.keys.pinPeer(pin);
    remote.setMessage(await encryptedMessage(identity, prekey, senderRoot, senderAgent, sender));
    const input: GetEncryptedMessagesInput = {
      after_sequence: 0,
      agent_id: "recipient",
      limit: 100,
      unread_only: false,
    };
    const observed: ReceiveEncryptedMessagesResult = await receiveEncryptedMessages(
      firstVault,
      remote,
      new FixedTestClock(),
      input,
      false,
      { acknowledgement: "none" },
    );
    expect(observed.messages[0]).toMatchObject({ wire: { read_at: null } });
    expect(remote.markCalls).toBe(0);
    remote.markFailure = new Error("Injected encrypted acknowledgement failure");
    await expect(
      receiveEncryptedMessages(firstVault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Injected encrypted acknowledgement failure");
    expect(remote.markCalls).toBe(1);
    expect(firstVault.getCachedMessage("22222222-2222-4222-8222-222222222222")).not.toBeNull();
    remote.markFailure = null;
    remote.markUpdated = 0;
    await expect(
      receiveEncryptedMessages(firstVault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Acknowledgement receipt count mismatch");
    expect(remote.markCalls).toBe(2);
    expect(firstVault.getCachedMessage("22222222-2222-4222-8222-222222222222")).not.toBeNull();
    remote.markUpdated = null;
    const results: readonly [ReceiveEncryptedMessagesResult, ReceiveEncryptedMessagesResult] =
      await Promise.all([
        receiveEncryptedMessages(firstVault, remote, new FixedTestClock(), input),
        receiveEncryptedMessages(secondVault, remote, new FixedTestClock(), input),
      ]);
    const firstMessage: VerifiedDecryptedMessage | undefined = results[0].messages[0];
    const secondMessage: VerifiedDecryptedMessage | undefined = results[1].messages[0];
    if (firstMessage === undefined || secondMessage === undefined) {
      throw new Error("Expected decrypted messages");
    }
    expect(firstMessage.content).toBe("received plaintext sentinel");
    expect(secondMessage.content).toBe("received plaintext sentinel");
    expect(firstMessage.wire.read_at).toBe(NOW.toISOString());
    expect(secondMessage.wire.read_at).toBe(NOW.toISOString());
    expect(remote.markCalls).toBe(4);
    expect(firstMessage.proof).toMatchObject({
      contextBinding: "verified",
      recipientPrekeyClass: "one_time",
      verificationMode: "strict",
    });
    const consumed: StoredPrekey | null = firstVault.keys.getPrekey(prekey.certificate.prekeyId);
    if (consumed === null) throw new Error("Expected consumed prekey row");
    expect(consumed.privateKey).toBeNull();
    const cached: CachedMessage | null = firstVault.getCachedMessage(
      "22222222-2222-4222-8222-222222222222",
    );
    if (cached === null) throw new Error("Expected decrypted cache entry");
    expect(cached.plaintext).toBe("received plaintext sentinel");
    const waited: WaitForDecryptedMessagesResult = await waitForDecryptedMessages(
      firstVault,
      remote,
      new FixedTestClock(),
      { after_sequence: 0, agent_id: "recipient", timeout_seconds: 5 },
    );
    const waitedMessage: VerifiedDecryptedMessage | undefined = waited.messages[0];
    if (waitedMessage === undefined) throw new Error("Expected waited decrypted message");
    expect(waitedMessage.content).toBe("received plaintext sentinel");
    expect(waitedMessage.wire.read_at).toBe(NOW.toISOString());
    expect(remote.markCalls).toBe(5);
    expect(firstVault.getCachedMessage("22222222-2222-4222-8222-222222222222")).not.toBeNull();
    const marked: MarkMessagesReadOutput = await markEncryptedMessagesRead(firstVault, remote, {
      agent_id: "recipient",
      message_ids: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(marked.updated).toBe(1);
    expect(remote.markCalls).toBe(6);
    expect(firstVault.getCachedMessage("22222222-2222-4222-8222-222222222222")).toBeNull();
  } finally {
    firstVault.close();
    secondVault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects signed-envelope context relabeling and public-chain substitution", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-proxy-tamper-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    const remote: ReceiveRemote = new ReceiveRemote();
    const identity: LocalPublishedIdentity = await publishLocalIdentity(
      vault,
      remote,
      "recipient",
      NOW,
    );
    const prekey: StoredPrekey | undefined = identity.oneTimePrekeys[0];
    if (prekey === undefined) throw new Error("Expected recipient one-time prekey");
    const senderRoot: SigningKeyPair = await createSigningKeyPair(bytes(32, 2));
    const senderAgent: SigningKeyPair = await createSigningKeyPair(bytes(32, 34));
    const sender: AgentKeyCertificate = await senderCertificate(senderRoot, senderAgent);
    await vault.keys.pinPeer({
      agentId: "sender",
      publicKey: senderRoot.publicKey,
      rootKeyId: sender.rootKeyId,
      tenantId: TENANT_ID,
      verificationMode: "strict",
      verifiedAt: NOW.toISOString(),
    });
    const message: EncryptedMessageDto = await encryptedMessage(
      identity,
      prekey,
      senderRoot,
      senderAgent,
      sender,
    );
    remote.setMessage({
      ...message,
      envelope: {
        ...message.envelope,
        header: { ...message.envelope.header, repository_name: "owner/other" },
      },
    });
    const input: GetEncryptedMessagesInput = {
      after_sequence: 0,
      agent_id: "recipient",
      limit: 100,
      unread_only: false,
    };
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Encrypted message verification failed");
    expect(remote.markCalls).toBe(0);
    remote.setMessage({
      ...message,
      sender_chain: { ...message.sender_chain, root_public_key: "A".repeat(43) },
    });
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow();
    remote.setMessage({
      ...message,
      envelope: {
        ...message.envelope,
        header: { ...message.envelope.header, recipient_id: "attacker" },
      },
    });
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Encrypted message verification failed");
    remote.setMessage({
      ...message,
      envelope: {
        ...message.envelope,
        header: { ...message.envelope.header, created_at: "2026-08-10T18:05:00.001Z" },
      },
    });
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Encrypted message verification failed");
    remote.setMessage({
      ...message,
      envelope: {
        ...message.envelope,
        header: {
          ...message.envelope.header,
          message_kind: "orchestration_request",
          orchestrator_policy_id: "44444444-4444-4444-8444-444444444444",
          sender_authority: "peer",
        },
      },
    });
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Encrypted message verification failed");
    const preserved: StoredPrekey | null = vault.keys.getPrekey(prekey.certificate.prekeyId);
    if (preserved === null) throw new Error("Expected recipient prekey after rejected tampering");
    expect(preserved.privateKey).not.toBeNull();
    remote.setMessage(message);
    const valid: ReceiveEncryptedMessagesResult = await receiveEncryptedMessages(
      vault,
      remote,
      new FixedTestClock(),
      input,
    );
    const validMessage: VerifiedDecryptedMessage | undefined = valid.messages[0];
    if (validMessage === undefined) throw new Error("Expected valid message after tamper attempts");
    expect(validMessage.content).toBe("received plaintext sentinel");
    const alternateEnvelope: EncryptedEnvelope = await encryptEnvelope(
      parseEnvelopeDto(message.envelope).header,
      "different valid ciphertext under the cached message identity",
      senderAgent.privateKey,
      prekey.certificate.prekeyPublicKey,
      new FixedRandom(await createBoxKeyPair(bytes(32, 193))),
    );
    remote.setMessage({ ...message, envelope: envelopeToDto(alternateEnvelope) });
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Encrypted message verification failed");
    remote.setMessage({ ...message, tenant_sequence: 2 });
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("Encrypted message verification failed");
    remote.setMessages([
      { ...message, tenant_sequence: 2 },
      { ...message, tenant_sequence: 2 },
    ]);
    await expect(
      receiveEncryptedMessages(vault, remote, new FixedTestClock(), input),
    ).rejects.toThrow("invalid encrypted inbox order");
    expect(remote.markCalls).toBe(1);
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
