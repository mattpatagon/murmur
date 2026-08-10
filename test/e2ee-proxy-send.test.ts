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
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  prekeyId,
  rootKeyId,
} from "../src/e2ee/certificates.js";
import { decryptEnvelope } from "../src/e2ee/envelope.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { SentReceipt } from "../src/e2ee/local-vault-rows.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeRandom,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";
import {
  type ProxySendInput,
  type ProxySendOptions,
  type ProxySendResult,
  sendEncryptedMessage,
} from "../src/e2ee/proxy-send.js";
import { type E2eeRemoteClient, EncryptionClaimExpiredError } from "../src/e2ee/remote-client.js";
import {
  type PrekeyCertificateDto,
  type PublicAgentKeyBundleDto,
  parseEnvelopeDto,
} from "../src/e2ee/wire-contracts.js";
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

const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const NOW: Instant = Instant.parse("2026-08-10T18:00:00.000Z");

class FixedTestClock implements Clock {
  readonly #now: Instant;

  public constructor(now: Instant) {
    this.#now = now;
  }

  public now(): Instant {
    return this.#now;
  }
}

function bytes(length: number, start: number): Uint8Array {
  const output: Uint8Array = new Uint8Array(length);
  for (let index: number = 0; index < output.byteLength; index += 1) {
    output[index] = (start + index) % 256;
  }
  return output;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

class SequentialRandom implements EnvelopeRandom {
  readonly #pairs: readonly BoxKeyPair[];
  #index: number = 0;

  public constructor(pairs: readonly BoxKeyPair[]) {
    this.#pairs = pairs;
  }

  public boxKeyPair(): BoxKeyPair {
    const pair: BoxKeyPair | undefined = this.#pairs[this.#index];
    if (pair === undefined) throw new Error("Deterministic envelope pairs are exhausted");
    this.#index += 1;
    return { privateKey: pair.privateKey.slice(), publicKey: pair.publicKey.slice() };
  }

  public bytes(length: number): Uint8Array {
    return bytes(length, 211 + this.#index);
  }
}

function uuidSequence(values: readonly string[]): () => string {
  let index: number = 0;
  return (): string => {
    const value: string | undefined = values[index];
    if (value === undefined) throw new Error("Deterministic UUIDs are exhausted");
    index += 1;
    return value;
  };
}

type RecipientFixture = {
  readonly bundle: PublicAgentKeyBundleDto;
  readonly prekeys: readonly BoxKeyPair[];
};

async function recipientFixture(): Promise<RecipientFixture> {
  const root: SigningKeyPair = await createSigningKeyPair(bytes(32, 1));
  const agent: SigningKeyPair = await createSigningKeyPair(bytes(32, 33));
  const fallback: BoxKeyPair = await createBoxKeyPair(bytes(32, 65));
  const first: BoxKeyPair = await createBoxKeyPair(bytes(32, 97));
  const second: BoxKeyPair = await createBoxKeyPair(bytes(32, 129));
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId: "recipient",
      createdAt: "2026-08-10T17:00:00.000Z",
      expiresAt: "2026-11-08T17:00:00.000Z",
      rootKeyId: await rootKeyId(root.publicKey),
      signingKeyId: await agentSigningKeyId(agent.publicKey),
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
  const certificateFor: (
    pair: BoxKeyPair,
    prekeyClass: "fallback" | "one_time",
  ) => Promise<PrekeyCertificate> = async (
    pair: BoxKeyPair,
    prekeyClass: "fallback" | "one_time",
  ): Promise<PrekeyCertificate> =>
    createPrekeyCertificate(
      {
        agentId: "recipient",
        agentSigningKeyId: agentCertificate.signingKeyId,
        createdAt: "2026-08-10T17:00:00.000Z",
        expiresAt: "2026-09-09T17:00:00.000Z",
        prekeyClass,
        prekeyId: await prekeyId(pair.publicKey),
        prekeyPublicKey: pair.publicKey,
      },
      agent.privateKey,
    );
  const fallbackCertificate: PrekeyCertificate = await certificateFor(fallback, "fallback");
  const oneTimeCertificates: readonly PrekeyCertificate[] = await Promise.all([
    certificateFor(first, "one_time"),
    certificateFor(second, "one_time"),
  ]);
  const certificateDto: (
    certificate: AgentKeyCertificate,
  ) => PublicAgentKeyBundleDto["agent_certificate"] = (
    certificate: AgentKeyCertificate,
  ): PublicAgentKeyBundleDto["agent_certificate"] => ({
    agent_id: certificate.agentId,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    root_key_id: certificate.rootKeyId,
    signature: encode(certificate.signature),
    signing_key_id: certificate.signingKeyId,
    signing_public_key: encode(certificate.signingPublicKey),
  });
  const prekeyDto: (certificate: PrekeyCertificate) => PrekeyCertificateDto = (
    certificate: PrekeyCertificate,
  ): PrekeyCertificateDto => ({
    agent_id: certificate.agentId,
    agent_signing_key_id: certificate.agentSigningKeyId,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    prekey_class: certificate.prekeyClass,
    prekey_id: certificate.prekeyId,
    prekey_public_key: encode(certificate.prekeyPublicKey),
    signature: encode(certificate.signature),
  });
  return {
    bundle: {
      agent_certificate: certificateDto(agentCertificate),
      fallback_prekey: prekeyDto(fallbackCertificate),
      one_time_prekeys: oneTimeCertificates.map(prekeyDto),
      root_key_id: agentCertificate.rootKeyId,
      root_public_key: encode(root.publicKey),
    },
    prekeys: [first, second],
  };
}

class FakeRemote implements E2eeRemoteClient {
  readonly #recipient: RecipientFixture;
  #published: PublishAgentKeyBundleInput | null = null;
  #committed: PutEncryptedMessageInput | null = null;
  public claimCalls: number = 0;
  public readonly puts: PutEncryptedMessageInput[] = [];

  public constructor(recipient: RecipientFixture) {
    this.#recipient = recipient;
  }

  public async capability(): Promise<E2eeCapabilityOutput> {
    return {
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
    this.#published = input;
    return {
      agent_id: input.agent_id,
      fallback_prekey_id: input.bundle.fallback_prekey.prekey_id,
      one_time_prekey_count: input.bundle.one_time_prekeys.length,
      published_at: NOW.toISOString(),
      root_key_id: input.bundle.root_key_id,
    };
  }

  public async claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
  ): Promise<ClaimEncryptionPrekeyOutput> {
    if (input.recipient_id !== "recipient") throw new Error("Unexpected fake recipient");
    const index: number = this.claimCalls;
    this.claimCalls += 1;
    const prekey: PrekeyCertificateDto | undefined = this.#recipient.bundle.one_time_prekeys[index];
    if (prekey === undefined) throw new Error("Fake recipient prekeys are exhausted");
    return {
      bundle: this.#recipient.bundle,
      claim_id:
        index === 0
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      claimed_at: NOW.toISOString(),
      expires_at: "2026-08-10T18:01:00.000Z",
      prekey_class: "one_time",
      prekey_id: prekey.prekey_id,
      provenance: {
        message_kind: "message",
        orchestrator_policy_id: null,
        sender_authority: "peer",
      },
      recipient_id: "recipient",
    };
  }

  public async putEncryptedMessage(
    input: PutEncryptedMessageInput,
  ): Promise<PutEncryptedMessageOutput> {
    this.puts.push(input);
    if (this.puts.length === 1) throw new EncryptionClaimExpiredError();
    const duplicate: boolean = this.#committed !== null;
    if (this.#committed === null) this.#committed = input;
    const committed: PutEncryptedMessageInput | null = this.#committed;
    const published: PublishAgentKeyBundleInput | null = this.#published;
    if (committed === null || published === null)
      throw new Error("Fake sender identity is missing");
    return {
      duplicate,
      message: {
        envelope: committed.envelope,
        read_at: null,
        sender_chain: {
          agent_certificate: published.bundle.agent_certificate,
          root_key_id: published.bundle.root_key_id,
          root_public_key: published.bundle.root_public_key,
        },
        tenant_sequence: 1,
      },
      retention_days: 30,
      status: "stored",
    };
  }

  public async getEncryptedMessages(
    _input: GetEncryptedMessagesInput,
  ): Promise<EncryptedInboxOutput> {
    throw new Error("Unused fake method");
  }
  public async waitForEncryptedMessages(
    _input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput> {
    throw new Error("Unused fake method");
  }
  public async markMessagesRead(_input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    throw new Error("Unused fake method");
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

test("reclaims an expired claim with a fresh counter and preserves committed retry bytes", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-proxy-send-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    const recipient: RecipientFixture = await recipientFixture();
    const remote: FakeRemote = new FakeRemote(recipient);
    vault.keys.expectPeerRoot({
      agentId: "recipient",
      rootKeyId: recipient.bundle.root_key_id,
      tenantId: TENANT_ID,
      verifiedAt: NOW.toISOString(),
    });
    const random: SequentialRandom = new SequentialRandom([
      await createBoxKeyPair(bytes(32, 161)),
      await createBoxKeyPair(bytes(32, 193)),
    ]);
    const options: ProxySendOptions = {
      expectedProvenance: {
        message_kind: "message",
        orchestrator_policy_id: null,
        sender_authority: "peer",
      },
      random,
      trustOnFirstUse: false,
      uuid: uuidSequence([
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ]),
    };
    const input: ProxySendInput = {
      content: "proxy plaintext sentinel",
      context: { branch: "feature/e2ee", client: "codex", repository: "owner/repository" },
      idempotencyKey: "send-proxy-1",
      recipientId: "recipient",
      senderId: "sender",
      threadId: "66666666-6666-4666-8666-666666666666",
    };
    const result: ProxySendResult = await sendEncryptedMessage(
      vault,
      remote,
      new FixedTestClock(NOW),
      input,
      options,
    );
    expect(result.content).toBe(input.content);
    expect(result.verificationMode).toBe("strict");
    expect(vault.keys.getExpectedPeerRoot(TENANT_ID, "recipient")).toBeNull();
    expect(remote.claimCalls).toBe(2);
    expect(remote.puts).toHaveLength(2);
    const first: PutEncryptedMessageInput | undefined = remote.puts[0];
    const second: PutEncryptedMessageInput | undefined = remote.puts[1];
    if (first === undefined || second === undefined) throw new Error("Expected two fake puts");
    expect(first.envelope.header.pair_counter).toBe(1);
    expect(second.envelope.header.pair_counter).toBe(2);
    expect(first.envelope.header.idempotency_key).toBe(second.envelope.header.idempotency_key);
    const committedEnvelope: EncryptedEnvelope = parseEnvelopeDto(second.envelope);
    const senderKey: Uint8Array = Buffer.from(
      result.output.message.sender_chain.agent_certificate.signing_public_key,
      "base64url",
    );
    const secondRecipientPrekey: BoxKeyPair | undefined = recipient.prekeys[1];
    if (secondRecipientPrekey === undefined) throw new Error("Expected second recipient prekey");
    expect(
      await decryptEnvelope(committedEnvelope, senderKey, secondRecipientPrekey.privateKey),
    ).toBe(input.content);
    if (input.idempotencyKey === null) throw new Error("Expected fixed idempotency key");
    const receipt: SentReceipt | null = vault.getSentReceipt(input.idempotencyKey);
    if (receipt === null) throw new Error("Expected committed receipt");
    expect(receipt.pairCounter).toBe(2);

    const retry: ProxySendResult = await sendEncryptedMessage(
      vault,
      remote,
      new FixedTestClock(NOW),
      input,
      options,
    );
    expect(retry.output.duplicate).toBe(true);
    expect(remote.claimCalls).toBe(2);
    const retryPut: PutEncryptedMessageInput | undefined = remote.puts[2];
    if (retryPut === undefined) throw new Error("Expected retry put");
    expect(retryPut.envelope).toEqual(second.envelope);
    await expect(
      sendEncryptedMessage(
        vault,
        remote,
        new FixedTestClock(NOW),
        { ...input, content: "conflicting plaintext" },
        options,
      ),
    ).rejects.toThrow("idempotency conflict");
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
