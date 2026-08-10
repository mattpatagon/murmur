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
import type { BoxKeyPair, EnvelopeRandom, SigningKeyPair } from "../src/e2ee/protocol.js";
import {
  type BroadcastRecipientVerification,
  broadcastEncryptedMessage,
  type ProxyBroadcastInput,
  type ProxyBroadcastOptions,
  type ProxyBroadcastResult,
} from "../src/e2ee/proxy-broadcast.js";
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

class FixedClock implements Clock {
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

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

type RecipientFixture = {
  readonly bundle: PublicAgentKeyBundleDto;
  readonly prekeys: readonly BoxKeyPair[];
};

async function recipientFixture(agentId: string, seed: number): Promise<RecipientFixture> {
  const root: SigningKeyPair = await createSigningKeyPair(bytes(32, seed));
  const agent: SigningKeyPair = await createSigningKeyPair(bytes(32, seed + 32));
  const fallback: BoxKeyPair = await createBoxKeyPair(bytes(32, seed + 64));
  const prekeys: readonly BoxKeyPair[] = [
    await createBoxKeyPair(bytes(32, seed + 96)),
    await createBoxKeyPair(bytes(32, seed + 128)),
  ];
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId,
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
    await createPrekeyCertificate(
      {
        agentId,
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
  const oneTimeCertificates: readonly PrekeyCertificate[] = await Promise.all(
    prekeys.map(
      async (pair: BoxKeyPair): Promise<PrekeyCertificate> =>
        await certificateFor(pair, "one_time"),
    ),
  );
  const agentDto: PublicAgentKeyBundleDto["agent_certificate"] = {
    agent_id: agentCertificate.agentId,
    created_at: agentCertificate.createdAt,
    expires_at: agentCertificate.expiresAt,
    root_key_id: agentCertificate.rootKeyId,
    signature: encode(agentCertificate.signature),
    signing_key_id: agentCertificate.signingKeyId,
    signing_public_key: encode(agentCertificate.signingPublicKey),
  };
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
      agent_certificate: agentDto,
      fallback_prekey: prekeyDto(fallbackCertificate),
      one_time_prekeys: oneTimeCertificates.map(prekeyDto),
      root_key_id: agentCertificate.rootKeyId,
      root_public_key: encode(root.publicKey),
    },
    prekeys,
  };
}

class SequentialRandom implements EnvelopeRandom {
  readonly #pairs: readonly BoxKeyPair[];
  #index: number = 0;

  public constructor(pairs: readonly BoxKeyPair[]) {
    this.#pairs = pairs;
  }

  public boxKeyPair(): BoxKeyPair {
    const pair: BoxKeyPair | undefined = this.#pairs[this.#index];
    if (pair === undefined) throw new Error("Envelope random fixture is exhausted");
    this.#index += 1;
    return { privateKey: pair.privateKey.slice(), publicKey: pair.publicKey.slice() };
  }

  public bytes(length: number): Uint8Array {
    return bytes(length, 220 + this.#index);
  }
}

function uuidSequence(values: readonly string[]): () => string {
  let index: number = 0;
  return (): string => {
    const value: string | undefined = values[index];
    if (value === undefined) throw new Error("UUID fixture is exhausted");
    index += 1;
    return value;
  };
}

class FakeBroadcastRemote implements E2eeRemoteClient {
  readonly #recipients: Readonly<Record<string, RecipientFixture>>;
  #committed: PrepareEncryptedBroadcastOutput | null = null;
  #generation: number = 0;
  #prepared: PrepareEncryptedBroadcastOutput | null = null;
  public cancelCalls: number = 0;
  public readonly puts: PutEncryptedBroadcastDeliveryInput[] = [];
  public publishInput: PublishAgentKeyBundleInput | null = null;

  public constructor(recipients: Readonly<Record<string, RecipientFixture>>) {
    this.#recipients = recipients;
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
    this.publishInput = input;
    return {
      agent_id: input.agent_id,
      fallback_prekey_id: input.bundle.fallback_prekey.prekey_id,
      one_time_prekey_count: input.bundle.one_time_prekeys.length,
      published_at: NOW.toISOString(),
      root_key_id: input.bundle.root_key_id,
    };
  }

  private claim(recipientId: string, index: number): ClaimEncryptionPrekeyOutput {
    const recipient: RecipientFixture | undefined = this.#recipients[recipientId];
    const prekey: PrekeyCertificateDto | undefined =
      recipient === undefined ? undefined : recipient.bundle.one_time_prekeys[index];
    if (recipient === undefined || prekey === undefined)
      throw new Error("Missing recipient fixture");
    const digit: string = recipientId === "alice" ? "1" : "2";
    return {
      bundle: recipient.bundle,
      claim_id: `${digit}${index + 1}111111-1111-4111-8111-111111111111`,
      claimed_at: NOW.toISOString(),
      expires_at: "2026-08-10T18:01:00.000Z",
      prekey_class: "one_time",
      prekey_id: prekey.prekey_id,
      provenance: {
        message_kind: "message",
        orchestrator_policy_id: null,
        sender_authority: "peer",
      },
      recipient_id: recipientId,
    };
  }

  public async prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
  ): Promise<PrepareEncryptedBroadcastOutput> {
    const active: PrepareEncryptedBroadcastOutput | null = this.#committed ?? this.#prepared;
    if (active !== null) return { ...active, duplicate: true };
    const suffix: string = this.#generation === 0 ? "3" : "4";
    const prepared: PrepareEncryptedBroadcastOutput = {
      broadcast_id: `${suffix}3333333-3333-4333-8333-333333333333`,
      claims: [this.claim("alice", this.#generation), this.claim("bob", this.#generation)],
      duplicate: false,
      expires_at: "2026-08-10T18:01:00.000Z",
      recipient_count: 2,
      thread_id: input.thread_id ?? "55555555-5555-4555-8555-555555555555",
    };
    this.#prepared = prepared;
    return prepared;
  }

  public async putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    this.puts.push(input);
    const recipientId: string = input.envelope.header.recipient_id;
    if (this.#generation === 0 && recipientId === "bob") {
      throw new EncryptionClaimExpiredError();
    }
    return { accepted: true, duplicate: this.#committed !== null, recipient_id: recipientId };
  }

  public async commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
  ): Promise<CommitEncryptedBroadcastOutput> {
    const prepared: PrepareEncryptedBroadcastOutput | null = this.#prepared ?? this.#committed;
    if (prepared === null || prepared.broadcast_id !== input.broadcast_id) {
      throw new Error("Unexpected broadcast commit");
    }
    const duplicate: boolean = this.#committed !== null;
    this.#committed = prepared;
    return {
      broadcast_id: prepared.broadcast_id,
      committed_at: NOW.toISOString(),
      duplicate,
      recipient_count: prepared.recipient_count,
      status: "stored",
    };
  }

  public async cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
  ): Promise<CancelEncryptedBroadcastOutput> {
    this.cancelCalls += 1;
    if (this.#committed !== null) return { cancelled: false };
    if (this.#prepared === null || this.#prepared.broadcast_id !== input.broadcast_id) {
      return { cancelled: false };
    }
    this.#prepared = null;
    this.#generation += 1;
    return { cancelled: true };
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
  public async getInboxSummary(_input: GetInboxSummaryInput): Promise<GetInboxSummaryOutput> {
    throw new Error("Unused fake method");
  }
  public async close(): Promise<void> {}
}

test("broadcasts all-or-nothing, re-encrypts expired claims, and retries exact bytes", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-broadcast-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    const alice: RecipientFixture = await recipientFixture("alice", 1);
    const bob: RecipientFixture = await recipientFixture("bob", 21);
    const remote: FakeBroadcastRemote = new FakeBroadcastRemote({ alice, bob });
    const randomPairs: readonly BoxKeyPair[] = await Promise.all(
      [101, 111, 121, 131].map(
        async (seed: number): Promise<BoxKeyPair> => await createBoxKeyPair(bytes(32, seed)),
      ),
    );
    const options: ProxyBroadcastOptions = {
      expectedProvenance: {
        message_kind: "message",
        orchestrator_policy_id: null,
        sender_authority: "peer",
      },
      random: new SequentialRandom(randomPairs),
      trustOnFirstUse: true,
      uuid: uuidSequence([
        "61111111-1111-4111-8111-111111111111",
        "62222222-2222-4222-8222-222222222222",
        "63333333-3333-4333-8333-333333333333",
        "64444444-4444-4444-8444-444444444444",
      ]),
    };
    const input: ProxyBroadcastInput = {
      audience: { repository: "mattpatagon/murmur" },
      content: "broadcast plaintext sentinel",
      context: { branch: "feature/e2ee", client: "codex", repository: "mattpatagon/murmur" },
      idempotencyKey: "broadcast-operation-1",
      senderId: "sender",
      threadId: null,
    };
    const result: ProxyBroadcastResult = await broadcastEncryptedMessage(
      vault,
      remote,
      new FixedClock(),
      input,
      options,
    );
    expect(result.output.recipient_count).toBe(2);
    expect(
      result.recipients.map(
        (recipient: BroadcastRecipientVerification): string => recipient.recipientId,
      ),
    ).toEqual(["alice", "bob"]);
    expect(remote.cancelCalls).toBe(1);
    expect(remote.puts).toHaveLength(4);
    const firstAlice: PutEncryptedBroadcastDeliveryInput | undefined = remote.puts[0];
    const freshAlice: PutEncryptedBroadcastDeliveryInput | undefined = remote.puts[2];
    const freshBob: PutEncryptedBroadcastDeliveryInput | undefined = remote.puts[3];
    if (firstAlice === undefined || freshAlice === undefined || freshBob === undefined) {
      throw new Error("Expected old and fresh broadcast deliveries");
    }
    expect(firstAlice.envelope.header.pair_counter).toBe(1);
    expect(freshAlice.envelope.header.pair_counter).toBe(2);
    expect(freshBob.envelope.header.pair_counter).toBe(2);
    expect(freshAlice.envelope.header.broadcast_id).toBe(result.output.broadcast_id);
    const sender: PublishAgentKeyBundleInput | null = remote.publishInput;
    if (sender === null) throw new Error("Sender signing chain was not published");
    const freshAlicePrekey: BoxKeyPair | undefined = alice.prekeys[1];
    const freshBobPrekey: BoxKeyPair | undefined = bob.prekeys[1];
    if (freshAlicePrekey === undefined || freshBobPrekey === undefined) {
      throw new Error("Fresh recipient prekeys are unavailable");
    }
    expect(
      await decryptEnvelope(
        parseEnvelopeDto(freshAlice.envelope),
        Buffer.from(sender.bundle.agent_certificate.signing_public_key, "base64url"),
        freshAlicePrekey.privateKey,
      ),
    ).toBe(input.content);
    expect(
      await decryptEnvelope(
        parseEnvelopeDto(freshBob.envelope),
        Buffer.from(sender.bundle.agent_certificate.signing_public_key, "base64url"),
        freshBobPrekey.privateKey,
      ),
    ).toBe(input.content);

    const retry: ProxyBroadcastResult = await broadcastEncryptedMessage(
      vault,
      remote,
      new FixedClock(),
      input,
      options,
    );
    expect(retry.output.duplicate).toBe(true);
    const retryAlice: PutEncryptedBroadcastDeliveryInput | undefined = remote.puts[4];
    const retryBob: PutEncryptedBroadcastDeliveryInput | undefined = remote.puts[5];
    if (retryAlice === undefined || retryBob === undefined) {
      throw new Error("Expected exact retry deliveries");
    }
    expect(retryAlice.envelope).toEqual(freshAlice.envelope);
    expect(retryBob.envelope).toEqual(freshBob.envelope);
    await expect(
      broadcastEncryptedMessage(
        vault,
        remote,
        new FixedClock(),
        { ...input, content: "conflicting content" },
        options,
      ),
    ).rejects.toThrow("idempotency conflict");
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
