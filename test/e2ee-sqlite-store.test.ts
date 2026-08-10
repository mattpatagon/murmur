import { expect, test } from "bun:test";
import {
  AgentId,
  type Clock,
  DisplayName,
  Instant,
  TenantId,
} from "../src/domain/value-objects.js";
import {
  type AgentKeyCertificate,
  type AgentKeyRevocation,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createAgentKeyRevocation,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  prekeyId,
  rootKeyId,
} from "../src/e2ee/certificates.js";
import { encryptEnvelope } from "../src/e2ee/envelope.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeaderInput,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";
import { envelopeToDto, publicBundleToDto } from "../src/e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyOutput,
  PrepareEncryptedBroadcastOutput,
  PutEncryptedBroadcastDeliveryInput,
  PutEncryptedMessageInput,
} from "../src/e2ee/wire-tools.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

const NOW: string = "2026-08-10T20:00:00.000Z";
const CREATED: string = "2026-08-10T19:00:00.000Z";
const KEY_EXPIRES: string = "2026-09-16T20:00:00.000Z";
const AGENT_EXPIRES: string = "2026-11-08T20:00:00.000Z";
const MESSAGE_EXPIRES: string = "2026-08-11T20:00:00.000Z";

class FixedClock implements Clock {
  public now(): Instant {
    return Instant.parse(NOW);
  }
}

type Identity = {
  readonly agent: SigningKeyPair;
  readonly agentCertificate: AgentKeyCertificate;
  readonly fallback: BoxKeyPair;
  readonly fallbackCertificate: PrekeyCertificate;
  readonly oneTime: BoxKeyPair;
  readonly oneTimeCertificate: PrekeyCertificate;
  readonly root: SigningKeyPair;
};

function seed(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

async function identity(agentId: string, offset: number): Promise<Identity> {
  const root: SigningKeyPair = await createSigningKeyPair(seed(offset));
  const agent: SigningKeyPair = await createSigningKeyPair(seed(offset + 1));
  const rootId: string = await rootKeyId(root.publicKey);
  const signingKeyId: string = await agentSigningKeyId(agent.publicKey);
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId,
      createdAt: CREATED,
      expiresAt: AGENT_EXPIRES,
      rootKeyId: rootId,
      signingKeyId,
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
  const fallback: BoxKeyPair = await createBoxKeyPair(seed(offset + 2));
  const oneTime: BoxKeyPair = await createBoxKeyPair(seed(offset + 3));
  const fallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt: CREATED,
      expiresAt: KEY_EXPIRES,
      prekeyClass: "fallback",
      prekeyId: await prekeyId(fallback.publicKey),
      prekeyPublicKey: fallback.publicKey,
    },
    agent.privateKey,
  );
  const oneTimeCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt: CREATED,
      expiresAt: KEY_EXPIRES,
      prekeyClass: "one_time",
      prekeyId: await prekeyId(oneTime.publicKey),
      prekeyPublicKey: oneTime.publicKey,
    },
    agent.privateKey,
  );
  return {
    agent,
    agentCertificate,
    fallback,
    fallbackCertificate,
    oneTime,
    oneTimeCertificate,
    root,
  };
}

function bundle(value: Identity): ReturnType<typeof publicBundleToDto> {
  return publicBundleToDto(
    value.root.publicKey,
    value.agentCertificate,
    value.fallbackCertificate,
    [value.oneTimeCertificate],
  );
}

function register(store: SqliteMessageStore, agentId: string, repository: string): void {
  store.registerAgent({
    agentId: AgentId.parse(agentId),
    displayName: DisplayName.parse(agentId),
    metadata: { machine: `${agentId}-machine`, repository },
  });
}

function recipientKey(identityValue: Identity, claim: ClaimEncryptionPrekeyOutput): Uint8Array {
  return claim.prekey_class === "one_time"
    ? identityValue.oneTime.publicKey
    : identityValue.fallback.publicKey;
}

async function encryptedPut(
  sender: Identity,
  recipient: Identity,
  claim: ClaimEncryptionPrekeyOutput,
  options: {
    readonly broadcastId: string | null;
    readonly idempotencyKey: string;
    readonly messageId: string;
    readonly pairCounter: number;
    readonly threadId: string;
  },
): Promise<PutEncryptedMessageInput> {
  const header: EnvelopeHeaderInput = {
    branchName: "feature/e2ee",
    broadcastId: options.broadcastId,
    client: "codex",
    createdAt: NOW,
    expiresAt: MESSAGE_EXPIRES,
    idempotencyKey: options.idempotencyKey,
    messageId: options.messageId,
    messageKind: claim.provenance.message_kind,
    orchestratorPolicyId: claim.provenance.orchestrator_policy_id,
    pairCounter: options.pairCounter,
    recipientAgentKeyId: recipient.agentCertificate.signingKeyId,
    recipientId: claim.recipient_id,
    recipientPrekeyClass: claim.prekey_class,
    recipientPrekeyId: claim.prekey_id,
    recipientRootKeyId: recipient.agentCertificate.rootKeyId,
    repositoryName: "mattpatagon/murmur",
    senderAgentKeyId: sender.agentCertificate.signingKeyId,
    senderAuthority: claim.provenance.sender_authority,
    senderId: "alice",
    senderRootKeyId: sender.agentCertificate.rootKeyId,
    tenantId: TenantId.founding().value,
    threadId: options.threadId,
  };
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    header,
    `secret:${options.messageId}`,
    sender.agent.privateKey,
    recipientKey(recipient, claim),
  );
  return { claim_id: claim.claim_id, envelope: envelopeToDto(envelope) };
}

test("SQLite stores verified direct ciphertext with atomic retry and inbox semantics", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", new FixedClock());
  try {
    register(store, "alice", "mattpatagon/murmur");
    register(store, "bob", "mattpatagon/murmur");
    const alice: Identity = await identity("alice", 1);
    const bob: Identity = await identity("bob", 10);
    const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
    await encrypted.publishAgentKeyBundle({ agent_id: "alice", bundle: bundle(alice) });
    await encrypted.publishAgentKeyBundle({ agent_id: "bob", bundle: bundle(bob) });
    await expect(
      encrypted.publishAgentKeyBundle({
        agent_id: "bob",
        bundle: { ...bundle(bob), root_public_key: bundle(alice).root_public_key },
      }),
    ).rejects.toThrow("validation failed");
    const claim: ClaimEncryptionPrekeyOutput = await encrypted.claimEncryptionPrekey({
      context: {
        branch: "feature/e2ee",
        client: "codex",
        repository: "mattpatagon/murmur",
      },
      recipient_id: "bob",
      sender_id: "alice",
    });
    expect(claim.prekey_class).toBe("one_time");
    const put: PutEncryptedMessageInput = await encryptedPut(alice, bob, claim, {
      broadcastId: null,
      idempotencyKey: "direct-1",
      messageId: "11111111-1111-4111-8111-111111111111",
      pairCounter: 1,
      threadId: "thread-direct",
    });
    const stored: Awaited<ReturnType<E2eeMessageStore["putEncryptedMessage"]>> =
      await encrypted.putEncryptedMessage(put);
    expect(stored.duplicate).toBe(false);
    expect((await encrypted.putEncryptedMessage(put)).duplicate).toBe(true);
    expect(
      await encrypted.getEncryptedMessages({
        after_sequence: 0,
        agent_id: "bob",
        limit: 100,
        unread_only: false,
      }),
    ).toMatchObject({ agent_id: "bob", inbox_version: 1, messages: [{ tenant_sequence: 1 }] });
    expect(
      await encrypted.markEncryptedMessagesRead({
        agent_id: "bob",
        message_ids: [put.envelope.header.message_id],
      }),
    ).toMatchObject({ updated: 1 });
    expect(await encrypted.getEncryptedInboxSummary({ agent_id: "bob" })).toMatchObject({
      inbox_version: 1,
      newest_sequence: 1,
      unread_count: 0,
    });

    const relabeled: PutEncryptedMessageInput = {
      ...put,
      envelope: {
        ...put.envelope,
        header: {
          ...put.envelope.header,
          idempotency_key: "relabeled-direct",
          tenant_id: TenantId.generate().value,
        },
      },
    };
    await expect(encrypted.putEncryptedMessage(relabeled)).rejects.toThrow();
    const fallbackClaim: ClaimEncryptionPrekeyOutput = await encrypted.claimEncryptionPrekey({
      context: {
        branch: "feature/e2ee",
        client: "codex",
        repository: "mattpatagon/murmur",
      },
      recipient_id: "bob",
      sender_id: "alice",
    });
    expect(fallbackClaim.prekey_class).toBe("fallback");
  } finally {
    store.close();
  }
});

test("SQLite preserves verified agent-key revocations across bundle rotation", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", new FixedClock());
  try {
    register(store, "alice", "mattpatagon/murmur");
    const original: Identity = await identity("alice", 61);
    const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
    await encrypted.publishAgentKeyBundle({ agent_id: "alice", bundle: bundle(original) });

    const replacementAgent: SigningKeyPair = await createSigningKeyPair(seed(70));
    const replacementCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
      {
        agentId: "alice",
        createdAt: CREATED,
        expiresAt: AGENT_EXPIRES,
        rootKeyId: original.agentCertificate.rootKeyId,
        signingKeyId: await agentSigningKeyId(replacementAgent.publicKey),
        signingPublicKey: replacementAgent.publicKey,
      },
      original.root.privateKey,
    );
    const replacementFallback: BoxKeyPair = await createBoxKeyPair(seed(71));
    const replacementFallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
      {
        agentId: "alice",
        agentSigningKeyId: replacementCertificate.signingKeyId,
        createdAt: CREATED,
        expiresAt: KEY_EXPIRES,
        prekeyClass: "fallback",
        prekeyId: await prekeyId(replacementFallback.publicKey),
        prekeyPublicKey: replacementFallback.publicKey,
      },
      replacementAgent.privateKey,
    );
    const revocation: AgentKeyRevocation = await createAgentKeyRevocation(
      {
        agentId: "alice",
        reason: "Compromise response",
        revokedAt: "2026-08-10T19:30:00.000Z",
        revokedSigningKeyId: original.agentCertificate.signingKeyId,
        rootKeyId: original.agentCertificate.rootKeyId,
      },
      original.root.privateKey,
    );
    const replacementBundle: ReturnType<typeof publicBundleToDto> = publicBundleToDto(
      original.root.publicKey,
      replacementCertificate,
      replacementFallbackCertificate,
      [],
      [revocation],
    );
    await expect(
      encrypted.publishAgentKeyBundle({ agent_id: "alice", bundle: replacementBundle }),
    ).resolves.toMatchObject({ agent_id: "alice" });
    await expect(
      encrypted.publishAgentKeyBundle({
        agent_id: "alice",
        bundle: publicBundleToDto(
          original.root.publicKey,
          replacementCertificate,
          replacementFallbackCertificate,
          [],
        ),
      }),
    ).rejects.toThrow("revocations cannot be removed or changed");
  } finally {
    store.close();
  }
});

test("SQLite keeps encrypted broadcasts invisible until complete atomic commit", async (): Promise<void> => {
  const store: SqliteMessageStore = new SqliteMessageStore(":memory:", new FixedClock());
  try {
    register(store, "alice", "mattpatagon/murmur");
    register(store, "bob", "mattpatagon/murmur");
    register(store, "charlie", "mattpatagon/murmur");
    const alice: Identity = await identity("alice", 21);
    const bob: Identity = await identity("bob", 31);
    const charlie: Identity = await identity("charlie", 41);
    const identities: ReadonlyMap<string, Identity> = new Map<string, Identity>([
      ["bob", bob],
      ["charlie", charlie],
    ]);
    const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
    await encrypted.publishAgentKeyBundle({ agent_id: "alice", bundle: bundle(alice) });
    await encrypted.publishAgentKeyBundle({ agent_id: "bob", bundle: bundle(bob) });
    await encrypted.publishAgentKeyBundle({ agent_id: "charlie", bundle: bundle(charlie) });
    const prepared: PrepareEncryptedBroadcastOutput = await encrypted.prepareEncryptedBroadcast({
      audience: { repository: "mattpatagon/murmur" },
      context: {
        branch: "feature/e2ee",
        client: "codex",
        repository: "mattpatagon/murmur",
      },
      idempotency_key: "broadcast-1",
      sender_id: "alice",
      thread_id: "thread-broadcast",
    });
    expect(
      await encrypted.prepareEncryptedBroadcast({
        audience: { repository: "mattpatagon/murmur" },
        context: {
          branch: "feature/e2ee",
          client: "codex",
          repository: "mattpatagon/murmur",
        },
        idempotency_key: "broadcast-1",
        sender_id: "alice",
        thread_id: "thread-broadcast",
      }),
    ).toMatchObject({ broadcast_id: prepared.broadcast_id, duplicate: true });
    expect(
      prepared.claims.map((claim: ClaimEncryptionPrekeyOutput): string => claim.recipient_id),
    ).toEqual(["bob", "charlie"]);
    let pairCounter: number = 1;
    let firstDelivery: PutEncryptedBroadcastDeliveryInput | null = null;
    for (const claim of prepared.claims) {
      const recipient: Identity | undefined = identities.get(claim.recipient_id);
      if (recipient === undefined) throw new Error("Missing recipient test identity");
      const put: PutEncryptedMessageInput = await encryptedPut(alice, recipient, claim, {
        broadcastId: prepared.broadcast_id,
        idempotencyKey: `broadcast-1:${claim.recipient_id}`,
        messageId:
          pairCounter === 1
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333",
        pairCounter,
        threadId: prepared.thread_id,
      });
      const delivery: PutEncryptedBroadcastDeliveryInput = {
        broadcast_id: prepared.broadcast_id,
        claim_id: claim.claim_id,
        envelope: put.envelope,
      };
      await encrypted.putEncryptedBroadcastDelivery(delivery);
      if (pairCounter === 1) {
        firstDelivery = delivery;
        expect(
          (): ReturnType<E2eeMessageStore["commitEncryptedBroadcast"]> =>
            encrypted.commitEncryptedBroadcast({ broadcast_id: prepared.broadcast_id }),
        ).toThrow("incomplete");
      }
      pairCounter += 1;
    }
    expect(
      await encrypted.getEncryptedMessages({
        after_sequence: 0,
        agent_id: "bob",
        limit: 100,
        unread_only: false,
      }),
    ).toMatchObject({ inbox_version: 0, messages: [] });
    const committed: Awaited<ReturnType<E2eeMessageStore["commitEncryptedBroadcast"]>> =
      await encrypted.commitEncryptedBroadcast({ broadcast_id: prepared.broadcast_id });
    expect(committed).toMatchObject({ duplicate: false, recipient_count: 2, status: "stored" });
    if (firstDelivery === null) throw new Error("Expected first encrypted broadcast delivery");
    expect(await encrypted.putEncryptedBroadcastDelivery(firstDelivery)).toMatchObject({
      accepted: true,
      duplicate: true,
      recipient_id: "bob",
    });
    expect(
      await encrypted.getEncryptedMessages({
        after_sequence: 0,
        agent_id: "bob",
        limit: 100,
        unread_only: false,
      }),
    ).toMatchObject({ inbox_version: 1, messages: [{ tenant_sequence: 1 }] });
    expect(
      await encrypted.getEncryptedMessages({
        after_sequence: 0,
        agent_id: "charlie",
        limit: 100,
        unread_only: false,
      }),
    ).toMatchObject({ inbox_version: 2, messages: [{ tenant_sequence: 2 }] });
    expect(
      await encrypted.commitEncryptedBroadcast({ broadcast_id: prepared.broadcast_id }),
    ).toMatchObject({ duplicate: true });
  } finally {
    store.close();
  }
});
