import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  encryptCanaryE2eeMessage,
} from "../scripts/lib/e2ee-canary-crypto.js";

import {
  AgentId,
  type Clock,
  DisplayName,
  Instant,
  TenantId,
} from "../src/domain/value-objects.js";
import {
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  prekeyId,
  rootKeyId,
} from "../src/e2ee/certificates.js";
import type { BoxKeyPair, SigningKeyPair } from "../src/e2ee/protocol.js";
import { publicBundleToDto } from "../src/e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyOutput,
  PrepareEncryptedBroadcastOutput,
  PutEncryptedMessageInput,
} from "../src/e2ee/wire-tools.js";
import type { E2eeMessageStore } from "../src/storage/e2ee-message-store.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

const PUBLISHED_AT: string = "2026-08-10T20:00:00.000Z";
const CLAIMED_AT: string = "2026-08-10T20:10:00.000Z";

class AdjustableClock implements Clock {
  private current: Instant = Instant.parse(PUBLISHED_AT);

  public set(value: string): void {
    this.current = Instant.parse(value);
  }

  public now(): Instant {
    return this.current;
  }
}

function seed(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

test("SQLite skips an expired one-time prekey when a later bundle prekey remains valid", async (): Promise<void> => {
  const clock: AdjustableClock = new AdjustableClock();
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-prekey-"));
  const path: string = join(directory, "messages.sqlite");
  try {
    const store: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      for (const agentId of ["alice", "bob"]) {
        store.registerAgent({
          agentId: AgentId.parse(agentId),
          displayName: DisplayName.parse(agentId),
          metadata: { machine: `${agentId}-machine`, repository: "mattpatagon/murmur" },
        });
      }
      const root: SigningKeyPair = await createSigningKeyPair(seed(80));
      const agent: SigningKeyPair = await createSigningKeyPair(seed(81));
      const signingKeyId: string = await agentSigningKeyId(agent.publicKey);
      const agentCertificate: Awaited<ReturnType<typeof createAgentKeyCertificate>> =
        await createAgentKeyCertificate(
          {
            agentId: "bob",
            createdAt: "2026-08-10T19:00:00.000Z",
            expiresAt: "2026-11-08T20:00:00.000Z",
            rootKeyId: await rootKeyId(root.publicKey),
            signingKeyId,
            signingPublicKey: agent.publicKey,
          },
          root.privateKey,
        );
      const fallback: BoxKeyPair = await createBoxKeyPair(seed(82));
      const expired: BoxKeyPair = await createBoxKeyPair(seed(83));
      const usable: BoxKeyPair = await createBoxKeyPair(seed(84));
      const certificate: (
        key: BoxKeyPair,
        prekeyClass: "fallback" | "one_time",
        expiresAt: string,
      ) => ReturnType<typeof createPrekeyCertificate> = async (
        key: BoxKeyPair,
        prekeyClass: "fallback" | "one_time",
        expiresAt: string,
      ): ReturnType<typeof createPrekeyCertificate> =>
        await createPrekeyCertificate(
          {
            agentId: "bob",
            agentSigningKeyId: signingKeyId,
            createdAt: "2026-08-10T19:00:00.000Z",
            expiresAt,
            prekeyClass,
            prekeyId: await prekeyId(key.publicKey),
            prekeyPublicKey: key.publicKey,
          },
          agent.privateKey,
        );
      const fallbackCertificate: Awaited<ReturnType<typeof certificate>> = await certificate(
        fallback,
        "fallback",
        "2026-09-16T20:00:00.000Z",
      );
      const expiredCertificate: Awaited<ReturnType<typeof certificate>> = await certificate(
        expired,
        "one_time",
        "2026-08-10T20:05:00.000Z",
      );
      const usableCertificate: Awaited<ReturnType<typeof certificate>> = await certificate(
        usable,
        "one_time",
        "2026-09-16T20:00:00.000Z",
      );
      const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
      await encrypted.publishAgentKeyBundle({
        agent_id: "bob",
        bundle: publicBundleToDto(root.publicKey, agentCertificate, fallbackCertificate, [
          expiredCertificate,
          usableCertificate,
        ]),
      });

      clock.set(CLAIMED_AT);
      const claim: ClaimEncryptionPrekeyOutput = await encrypted.claimEncryptionPrekey({
        context: {
          branch: "feature/hosted-e2ee",
          client: "codex",
          repository: "mattpatagon/murmur",
        },
        recipient_id: "bob",
        sender_id: "alice",
      });

      expect(claim.prekey_class).toBe("one_time");
      expect(claim.prekey_id).toBe(usableCertificate.prekeyId);
      expect(
        claim.bundle.one_time_prekeys.map(
          (prekey: (typeof claim.bundle.one_time_prekeys)[number]): string => prekey.prekey_id,
        ),
      ).toEqual([usableCertificate.prekeyId]);

      clock.set("2026-08-10T20:20:00.000Z");
      await encrypted.getEncryptedInboxSummary({ agent_id: "bob" });
    } finally {
      store.close();
    }
    using database: Database = new Database(path, { readonly: true });
    expect(database.query("SELECT COUNT(*) AS count FROM e2ee_claims").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM e2ee_prekeys").get()).toEqual({
      count: 1,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SQLite physically reclaims cancelled encrypted broadcast artifacts", async (): Promise<void> => {
  const clock: AdjustableClock = new AdjustableClock();
  clock.set(CLAIMED_AT);
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-broadcast-prune-"));
  const path: string = join(directory, "messages.sqlite");
  try {
    const store: SqliteMessageStore = new SqliteMessageStore(path, clock);
    try {
      for (const agentId of ["broadcast-alice", "broadcast-bob"]) {
        store.registerAgent({
          agentId: AgentId.parse(agentId),
          displayName: DisplayName.parse(agentId),
          metadata: { machine: `${agentId}-machine`, repository: "mattpatagon/murmur" },
        });
      }
      const now: Date = new Date(CLAIMED_AT);
      const alice: CanaryE2eeIdentity = await createCanaryE2eeIdentity("broadcast-alice", now);
      const bob: CanaryE2eeIdentity = await createCanaryE2eeIdentity("broadcast-bob", now);
      const encrypted: E2eeMessageStore = store.scopeE2ee(TenantId.founding());
      await encrypted.publishAgentKeyBundle({
        agent_id: "broadcast-alice",
        bundle: canaryE2eeBundle(alice),
      });
      await encrypted.publishAgentKeyBundle({
        agent_id: "broadcast-bob",
        bundle: canaryE2eeBundle(bob),
      });
      const prepared: PrepareEncryptedBroadcastOutput = await encrypted.prepareEncryptedBroadcast({
        audience: { repository: "mattpatagon/murmur" },
        context: {
          branch: "feature/hosted-e2ee",
          client: "codex",
          repository: "mattpatagon/murmur",
        },
        sender_id: "broadcast-alice",
      });
      const claim: ClaimEncryptionPrekeyOutput | undefined = prepared.claims[0];
      if (claim === undefined) throw new Error("Broadcast prune claim is missing");
      const put: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
        branch: "feature/hosted-e2ee",
        broadcastId: prepared.broadcast_id,
        claim,
        idempotencyKey: "broadcast-prune",
        now,
        pairCounter: 1,
        plaintext: "cancelled ciphertext sentinel",
        recipient: bob,
        repository: "mattpatagon/murmur",
        sender: alice,
        senderId: "broadcast-alice",
        tenantId: TenantId.founding().value,
        threadId: prepared.thread_id,
      });
      await encrypted.putEncryptedBroadcastDelivery({
        broadcast_id: prepared.broadcast_id,
        claim_id: claim.claim_id,
        envelope: put.envelope,
      });
      expect(
        await encrypted.cancelEncryptedBroadcast({ broadcast_id: prepared.broadcast_id }),
      ).toEqual({ cancelled: true });
      clock.set("2026-08-10T20:20:00.000Z");
      await encrypted.getEncryptedInboxSummary({ agent_id: "broadcast-bob" });
    } finally {
      store.close();
    }
    using database: Database = new Database(path, { readonly: true });
    for (const table of ["e2ee_broadcast_deliveries", "e2ee_broadcasts", "e2ee_claims"]) {
      expect(database.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(
      database
        .query(
          "SELECT claim_count, pending_broadcast_count, pending_ciphertext_bytes, pending_delivery_count FROM e2ee_usage",
        )
        .get(),
    ).toEqual({
      claim_count: 0,
      pending_broadcast_count: 0,
      pending_ciphertext_bytes: 0,
      pending_delivery_count: 0,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
