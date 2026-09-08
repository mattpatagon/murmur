import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  AgentId,
  type Clock,
  DisplayName,
  Instant,
  type TenantId,
} from "../src/domain/value-objects.js";
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
  EncryptedInboxOutput,
  EncryptedMessageDto,
  PrepareEncryptedBroadcastOutput,
  PutEncryptedBroadcastDeliveryInput,
  PutEncryptedMessageInput,
  PutEncryptedMessageOutput,
} from "../src/e2ee/wire-tools.js";
import type {
  E2eeMessageStore,
  EncryptedInboxUpdateHandler,
} from "../src/storage/e2ee-message-store.js";
import type { InboxSubscription, MessageStore } from "../src/storage/message-store.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { testE2eeBundleWithRevokedAgentKey } from "./support/e2ee-hosted-crypto.js";
import {
  createPostgresE2eeTestTenant,
  type PostgresE2eeTestTenant,
} from "./support/e2ee-postgres-tenant.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";

const databaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

class FixedClock implements Clock {
  private readonly value: Instant;

  public constructor(value: Instant) {
    this.value = value;
  }

  public now(): Instant {
    return this.value;
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

async function identity(
  agentId: string,
  createdAt: string,
  keyExpires: string,
  agentExpires: string,
): Promise<Identity> {
  const root: SigningKeyPair = await createSigningKeyPair(null);
  const agent: SigningKeyPair = await createSigningKeyPair(null);
  const rootId: string = await rootKeyId(root.publicKey);
  const signingKeyId: string = await agentSigningKeyId(agent.publicKey);
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId,
      createdAt,
      expiresAt: agentExpires,
      rootKeyId: rootId,
      signingKeyId,
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
  const fallback: BoxKeyPair = await createBoxKeyPair(null);
  const oneTime: BoxKeyPair = await createBoxKeyPair(null);
  const fallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt,
      expiresAt: keyExpires,
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
      createdAt,
      expiresAt: keyExpires,
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

type SequenceSignal = {
  readonly notify: (sequence: number) => void;
  readonly promise: Promise<number>;
};

function sequenceSignal(): SequenceSignal {
  let notifyHandler: (sequence: number) => void = (): void => {};
  const promise: Promise<number> = new Promise<number>(
    (resolve: (sequence: number) => void): void => {
      notifyHandler = resolve;
    },
  );
  return {
    notify: (sequence: number): void => {
      notifyHandler(sequence);
    },
    promise,
  };
}

async function notificationTimeout(): Promise<never> {
  await Bun.sleep(2_000);
  throw new Error("Encrypted inbox notification timed out");
}

function bundle(value: Identity): ReturnType<typeof publicBundleToDto> {
  return publicBundleToDto(
    value.root.publicKey,
    value.agentCertificate,
    value.fallbackCertificate,
    [value.oneTimeCertificate],
  );
}

function recipientKey(value: Identity, claim: ClaimEncryptionPrekeyOutput): Uint8Array {
  return claim.prekey_class === "one_time" ? value.oneTime.publicKey : value.fallback.publicKey;
}

async function encryptedPut(
  tenantId: TenantId,
  senderId: string,
  sender: Identity,
  recipient: Identity,
  claim: ClaimEncryptionPrekeyOutput,
  now: Instant,
  options: {
    readonly broadcastId: string | null;
    readonly idempotencyKey: string;
    readonly messageId: string;
    readonly pairCounter: number;
    readonly repository: string;
    readonly threadId: string;
  },
): Promise<PutEncryptedMessageInput> {
  const header: EnvelopeHeaderInput = {
    branchName: "feature/e2ee-postgres",
    broadcastId: options.broadcastId,
    client: "codex",
    createdAt: now.toISOString(),
    expiresAt: now.addDays(1).toISOString(),
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
    repositoryName: options.repository,
    senderAgentKeyId: sender.agentCertificate.signingKeyId,
    senderAuthority: claim.provenance.sender_authority,
    senderId,
    senderRootKeyId: sender.agentCertificate.rootKeyId,
    tenantId: tenantId.value,
    threadId: options.threadId,
  };
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    header,
    `postgres-secret:${options.messageId}`,
    sender.agent.privateKey,
    recipientKey(recipient, claim),
  );
  return { claim_id: claim.claim_id, envelope: envelopeToDto(envelope) };
}

test.skipIf(!postgresConfigured)(
  "PostgreSQL persists verified E2E direct and atomic broadcast ciphertext",
  async (): Promise<void> => {
    const configuredDatabaseUrl: string | undefined = databaseUrl;
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    if (configuredDatabaseUrl === undefined || configuredAdminDatabaseUrl === undefined) {
      throw new Error("Hosted database URLs are required");
    }
    const now: Instant = Instant.parse(new Date().toISOString());
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 10);
    const repository: string = `e2ee-test/repo-${unique}`;
    const aliceId: string = `e2ee-alice-${unique}`;
    const bobId: string = `e2ee-bob-${unique}`;
    const charlieId: string = `e2ee-charlie-${unique}`;
    const testTenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
      configuredAdminDatabaseUrl,
      testTlsConfiguration,
    );
    const store: PostgresMessageStore = await PostgresMessageStore.connect(
      configuredDatabaseUrl,
      testTlsConfiguration,
      new FixedClock(now),
    );
    try {
      await testTenant.beginProvisioning();
      const tenantStore: MessageStore = store.scope(testTenant.tenantId);
      for (const agentId of [aliceId, bobId, charlieId]) {
        await tenantStore.registerAgent({
          agentId: AgentId.parse(agentId),
          displayName: DisplayName.parse(agentId),
          metadata: { machine: `${agentId}-machine`, repository },
        });
      }
      const createdAt: string = now.addMinutes(-60).toISOString();
      const keyExpires: string = now.addDays(40).toISOString();
      const agentExpires: string = now.addDays(80).toISOString();
      const alice: Identity = await identity(aliceId, createdAt, keyExpires, agentExpires);
      const bob: Identity = await identity(bobId, createdAt, keyExpires, agentExpires);
      const charlie: Identity = await identity(charlieId, createdAt, keyExpires, agentExpires);
      const encrypted: E2eeMessageStore = store.scopeE2ee(testTenant.tenantId);
      await encrypted.publishAgentKeyBundle({ agent_id: aliceId, bundle: bundle(alice) });
      await encrypted.publishAgentKeyBundle({ agent_id: bobId, bundle: bundle(bob) });
      await encrypted.publishAgentKeyBundle({ agent_id: charlieId, bundle: bundle(charlie) });
      expect(
        await encrypted.publishAgentKeyBundle({ agent_id: bobId, bundle: bundle(bob) }),
      ).toMatchObject({ one_time_prekey_count: 1 });
      const additionalBobPrekey: BoxKeyPair = await createBoxKeyPair(null);
      const additionalBobCertificate: PrekeyCertificate = await createPrekeyCertificate(
        {
          agentId: bobId,
          agentSigningKeyId: bob.agentCertificate.signingKeyId,
          createdAt,
          expiresAt: keyExpires,
          prekeyClass: "one_time",
          prekeyId: await prekeyId(additionalBobPrekey.publicKey),
          prekeyPublicKey: additionalBobPrekey.publicKey,
        },
        bob.agent.privateKey,
      );
      const replenishedBob: ReturnType<typeof publicBundleToDto> = publicBundleToDto(
        bob.root.publicKey,
        bob.agentCertificate,
        bob.fallbackCertificate,
        [bob.oneTimeCertificate, additionalBobCertificate],
      );
      expect(
        await encrypted.publishAgentKeyBundle({ agent_id: bobId, bundle: replenishedBob }),
      ).toMatchObject({ one_time_prekey_count: 2 });
      const changedBobRoot: Identity = await identity(bobId, createdAt, keyExpires, agentExpires);
      await expect(
        encrypted.publishAgentKeyBundle({ agent_id: bobId, bundle: bundle(changedBobRoot) }),
      ).rejects.toThrow("root key cannot change");
      await expect(
        encrypted.publishAgentKeyBundle({
          agent_id: bobId,
          bundle: { ...bundle(bob), root_public_key: bundle(alice).root_public_key },
        }),
      ).rejects.toThrow("validation failed");
      await testTenant.enforce();

      const claim: ClaimEncryptionPrekeyOutput = await encrypted.claimEncryptionPrekey({
        context: { branch: "feature/e2ee-postgres", client: "codex", repository },
        recipient_id: bobId,
        sender_id: aliceId,
      });
      expect(claim.prekey_class).toBe("one_time");
      const put: PutEncryptedMessageInput = await encryptedPut(
        testTenant.tenantId,
        aliceId,
        alice,
        bob,
        claim,
        now,
        {
          broadcastId: null,
          idempotencyKey: `direct-${unique}`,
          messageId: randomUUID(),
          pairCounter: 1,
          repository,
          threadId: `direct-thread-${unique}`,
        },
      );
      const notification: SequenceSignal = sequenceSignal();
      const handler: EncryptedInboxUpdateHandler = async (sequence: number): Promise<void> => {
        notification.notify(sequence);
      };
      const subscription: InboxSubscription = await encrypted.watchEncryptedInbox(
        bobId,
        0,
        handler,
      );
      const direct: PutEncryptedMessageOutput = await encrypted.putEncryptedMessage(put);
      const notifiedSequence: number = await Promise.race([
        notification.promise,
        notificationTimeout(),
      ]);
      await subscription.close();
      expect(direct.duplicate).toBe(false);
      expect(await encrypted.putEncryptedMessage(put)).toMatchObject({ duplicate: true });
      expect(notifiedSequence).toBe(direct.message.tenant_sequence);
      expect(
        await encrypted.acknowledgeEncryptedMessages({
          agent_id: bobId,
          message_ids: [put.envelope.header.message_id],
        }),
      ).toEqual({
        receipts: [{ message_id: put.envelope.header.message_id, read_at: now.toISOString() }],
        updated: 1,
      });
      const prepared: PrepareEncryptedBroadcastOutput = await encrypted.prepareEncryptedBroadcast({
        audience: { repository },
        context: { branch: "feature/e2ee-postgres", client: "codex", repository },
        idempotency_key: `broadcast-${unique}`,
        sender_id: aliceId,
        thread_id: `broadcast-thread-${unique}`,
      });
      expect(
        prepared.claims.map((item: ClaimEncryptionPrekeyOutput): string => item.recipient_id),
      ).toEqual([bobId, charlieId]);
      await expect(
        encrypted.prepareEncryptedBroadcast({
          audience: { repository },
          context: { branch: "feature/e2ee-postgres", client: "codex", repository },
          idempotency_key: `broadcast-${unique}`,
          sender_id: aliceId,
          thread_id: `conflicting-thread-${unique}`,
        }),
      ).rejects.toThrow("different message");
      const identities: ReadonlyMap<string, Identity> = new Map([
        [bobId, bob],
        [charlieId, charlie],
      ]);
      let counter: number = 2;
      let firstDelivery: PutEncryptedBroadcastDeliveryInput | null = null;
      for (const broadcastClaim of prepared.claims) {
        const recipient: Identity | undefined = identities.get(broadcastClaim.recipient_id);
        if (recipient === undefined) throw new Error("Broadcast test identity is missing");
        const broadcastPut: PutEncryptedMessageInput = await encryptedPut(
          testTenant.tenantId,
          aliceId,
          alice,
          recipient,
          broadcastClaim,
          now,
          {
            broadcastId: prepared.broadcast_id,
            idempotencyKey: `broadcast-${unique}:${broadcastClaim.recipient_id}`,
            messageId: randomUUID(),
            pairCounter: counter,
            repository,
            threadId: prepared.thread_id,
          },
        );
        const delivery: PutEncryptedBroadcastDeliveryInput = {
          broadcast_id: prepared.broadcast_id,
          claim_id: broadcastClaim.claim_id,
          envelope: broadcastPut.envelope,
        };
        await encrypted.putEncryptedBroadcastDelivery(delivery);
        if (firstDelivery === null) {
          firstDelivery = delivery;
          await expect(
            encrypted.commitEncryptedBroadcast({ broadcast_id: prepared.broadcast_id }),
          ).rejects.toThrow("incomplete");
        }
        counter += 1;
      }
      const beforeCommit: EncryptedInboxOutput = await encrypted.getEncryptedMessages({
        after_sequence: direct.message.tenant_sequence,
        agent_id: bobId,
        limit: 100,
        unread_only: false,
      });
      expect(beforeCommit.messages).toHaveLength(0);
      expect(
        await encrypted.commitEncryptedBroadcast({ broadcast_id: prepared.broadcast_id }),
      ).toMatchObject({ duplicate: false, recipient_count: 2 });
      if (firstDelivery === null) throw new Error("Broadcast test delivery is missing");
      expect(await encrypted.putEncryptedBroadcastDelivery(firstDelivery)).toMatchObject({
        duplicate: true,
      });
      const bobBroadcast: EncryptedInboxOutput = await encrypted.getEncryptedMessages({
        after_sequence: direct.message.tenant_sequence,
        agent_id: bobId,
        limit: 100,
        unread_only: false,
      });
      const charlieBroadcast: EncryptedInboxOutput = await encrypted.getEncryptedMessages({
        after_sequence: 0,
        agent_id: charlieId,
        limit: 100,
        unread_only: false,
      });
      expect(bobBroadcast.messages).toHaveLength(1);
      expect(charlieBroadcast.messages).toHaveLength(1);
      const bobMessage: EncryptedMessageDto | undefined = bobBroadcast.messages[0];
      const charlieMessage: EncryptedMessageDto | undefined = charlieBroadcast.messages[0];
      if (bobMessage === undefined || charlieMessage === undefined) {
        throw new Error("Committed broadcast delivery is missing");
      }
      expect(charlieMessage.tenant_sequence).toBe(bobMessage.tenant_sequence + 1);

      const cancelled: PrepareEncryptedBroadcastOutput = await encrypted.prepareEncryptedBroadcast({
        audience: { repository },
        context: { branch: "feature/e2ee-postgres", client: "codex", repository },
        idempotency_key: `cancel-${unique}`,
        sender_id: aliceId,
      });
      expect(
        await encrypted.cancelEncryptedBroadcast({ broadcast_id: cancelled.broadcast_id }),
      ).toEqual({ cancelled: true });
      expect(
        await encrypted.cancelEncryptedBroadcast({ broadcast_id: cancelled.broadcast_id }),
      ).toEqual({ cancelled: true });

      const revokedClaim: ClaimEncryptionPrekeyOutput = await encrypted.claimEncryptionPrekey({
        context: { branch: "feature/e2ee-postgres", client: "codex", repository },
        recipient_id: bobId,
        sender_id: aliceId,
      });
      const revokedPut: PutEncryptedMessageInput = await encryptedPut(
        testTenant.tenantId,
        aliceId,
        alice,
        bob,
        revokedClaim,
        now,
        {
          broadcastId: null,
          idempotencyKey: `revoked-${unique}`,
          messageId: randomUUID(),
          pairCounter: counter,
          repository,
          threadId: `revoked-thread-${unique}`,
        },
      );
      await encrypted.publishAgentKeyBundle({
        agent_id: bobId,
        bundle: await testE2eeBundleWithRevokedAgentKey(bob, bobId, new Date(now.toISOString())),
      });
      await expect(encrypted.putEncryptedMessage(revokedPut)).rejects.toThrow(
        "recipient signing key was revoked",
      );
    } finally {
      await store.close();
      await testTenant.close();
    }
  },
  20_000,
);
