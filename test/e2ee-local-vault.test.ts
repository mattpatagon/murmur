import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CacheDecryptedInput, LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type {
  CachedMessage,
  OutboxItem,
  PeerPin,
  StoredAgentKey,
  StoredPrekey,
  StoredRootKey,
} from "../src/e2ee/local-vault-rows.js";
import { defaultE2eeVaultPath, windowsVaultAclArguments } from "../src/e2ee/vault-paths.js";

function fixedDigest(start: number): Uint8Array {
  const digest: Uint8Array = new Uint8Array(32);
  for (let index: number = 0; index < digest.byteLength; index += 1) {
    digest[index] = (start + index) % 256;
  }
  return digest;
}

function withTempDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-vault-"));
  return Promise.resolve()
    .then((): Promise<void> | void => run(directory))
    .finally((): void => {
      rmSync(directory, { force: true, recursive: true });
    });
}

test("derives portable user-scoped vault paths", (): void => {
  expect(defaultE2eeVaultPath({ HOME: "/home/alice" }, "linux")).toBe(
    "/home/alice/.local/share/murmur/e2ee-vault.sqlite",
  );
  expect(defaultE2eeVaultPath({ HOME: "/Users/alice" }, "darwin")).toBe(
    "/Users/alice/Library/Application Support/murmur/e2ee-vault.sqlite",
  );
  expect(defaultE2eeVaultPath({ LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, "win32")).toBe(
    "C:\\Users\\alice\\AppData\\Local\\murmur\\e2ee-vault.sqlite",
  );
  expect(
    windowsVaultAclArguments("C:\\vault.sqlite", {
      USERDOMAIN: "WORKSTATION",
      USERNAME: "alice",
    }),
  ).toEqual([
    "C:\\vault.sqlite",
    "/inheritance:r",
    "/grant:r",
    // biome-ignore lint/security/noSecrets: This is a public Windows ACL fixture, not credential material.
    "WORKSTATION\\alice:(F)",
  ]);
  expect((): readonly string[] =>
    windowsVaultAclArguments("C:\\vault.sqlite", { USERNAME: "bad:user" }),
  ).toThrow("identity is unavailable");
});

test("creates one installation root across concurrent vault handles with owner-only permissions", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const path: string = join(directory, "private", "vault.sqlite");
    const first: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    const second: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    try {
      const roots: readonly [StoredRootKey, StoredRootKey] = await Promise.all([
        first.keys.getOrCreateRoot("2026-08-10T17:00:00.000Z"),
        second.keys.getOrCreateRoot("2026-08-10T17:00:00.000Z"),
      ]);
      expect(roots[0].rootKeyId).toBe(roots[1].rootKeyId);
      expect(roots[0].privateKey).toEqual(roots[1].privateKey);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, "private")).mode & 0o777).toBe(0o700);
    } finally {
      first.close();
      second.close();
    }
  });
});

test("persists certified agent keys, bounded prekeys, and strict peer pins", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
    try {
      const agent: StoredAgentKey = await vault.keys.getOrCreateAgent(
        "machine:codex:repo:alice",
        "2026-08-10T17:00:00.000Z",
        "2026-11-08T17:00:00.000Z",
      );
      const prekeys: readonly StoredPrekey[] = await vault.keys.replenishPrekeys(
        agent.certificate.agentId,
        "one_time",
        3,
        "2026-08-10T17:00:00.000Z",
        "2026-09-09T17:00:00.000Z",
      );
      expect(prekeys).toHaveLength(3);
      expect(vault.keys.listPrekeys(agent.certificate.agentId, "one_time")).toHaveLength(3);
      const root: StoredRootKey | null = vault.keys.getRoot();
      if (root === null) throw new Error("Expected installation root");
      const tofu: PeerPin = {
        agentId: "machine:codex:other:bob",
        publicKey: root.publicKey,
        rootKeyId: root.rootKeyId,
        tenantId: "11111111-1111-4111-8111-111111111111",
        verificationMode: "tofu",
        verifiedAt: "2026-08-10T17:00:00.000Z",
      };
      expect((await vault.keys.pinPeer(tofu)).verificationMode).toBe("tofu");
      const strict: PeerPin = { ...tofu, verificationMode: "strict" };
      expect((await vault.keys.pinPeer(strict)).verificationMode).toBe("strict");
      await expect(vault.keys.pinPeer(tofu)).rejects.toThrow("cannot be downgraded");
      const changed: PeerPin = {
        ...strict,
        publicKey: fixedDigest(77),
      };
      await expect(vault.keys.pinPeer(changed)).rejects.toThrow("fingerprint does not match");
    } finally {
      vault.close();
    }
  });
});

test("serializes each sender-recipient outbox and preserves exact retry bytes", async (): Promise<void> => {
  await withTempDirectory((directory: string): void => {
    const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
    try {
      const first: OutboxItem = vault.beginOutbox({
        createdAt: "2026-08-10T17:00:00.000Z",
        logicalId: "logical-1",
        plaintext: "first secret",
        plaintextDigest: fixedDigest(1),
        recipientId: "bob",
        senderId: "alice",
        tenantId: "11111111-1111-4111-8111-111111111111",
      });
      expect(first.pairCounter).toBe(1);
      expect(
        vault.beginOutbox({
          createdAt: first.createdAt,
          logicalId: first.logicalId,
          plaintext: first.plaintext,
          plaintextDigest: first.plaintextDigest,
          recipientId: first.recipientId,
          senderId: first.senderId,
          tenantId: first.tenantId,
        }).pairCounter,
      ).toBe(1);
      expect(
        (): OutboxItem =>
          vault.beginOutbox({
            createdAt: first.createdAt,
            logicalId: "logical-2",
            plaintext: "blocked",
            plaintextDigest: fixedDigest(2),
            recipientId: first.recipientId,
            senderId: first.senderId,
            tenantId: first.tenantId,
          }),
      ).toThrow("Resolve the existing pair outbox");
      const claimId: string = "11111111-1111-4111-8111-111111111111";
      const ready: OutboxItem = vault.setOutboxEnvelope(
        first.logicalId,
        claimId,
        '{"ciphertext":"abc"}',
      );
      expect(ready.claimId).toBe(claimId);
      expect(ready.envelopeJson).toBe('{"ciphertext":"abc"}');
      expect(
        vault.setOutboxEnvelope(first.logicalId, claimId, '{"ciphertext":"abc"}').envelopeJson,
      ).toBe(ready.envelopeJson);
      expect(
        (): OutboxItem =>
          vault.setOutboxEnvelope(first.logicalId, claimId, '{"ciphertext":"different"}'),
      ).toThrow("conflict");
      const replaced: OutboxItem = vault.replaceExpiredOutboxClaim(
        first.logicalId,
        "2026-08-10T17:00:30.000Z",
      );
      expect(replaced.pairCounter).toBe(2);
      expect(replaced.claimId).toBeNull();
      expect(replaced.envelopeJson).toBeNull();
      expect(
        vault.replaceExpiredOutboxClaim(first.logicalId, "2026-08-10T17:00:31.000Z").pairCounter,
      ).toBe(2);
      expect(vault.resolveOutbox(first.logicalId)).toBe(true);
      const second: OutboxItem = vault.beginOutbox({
        createdAt: "2026-08-10T17:01:00.000Z",
        logicalId: "logical-2",
        plaintext: "second secret",
        plaintextDigest: fixedDigest(2),
        recipientId: first.recipientId,
        senderId: first.senderId,
        tenantId: first.tenantId,
      });
      expect(second.pairCounter).toBe(3);
    } finally {
      vault.close();
    }
  });
});

test("atomically caches plaintext, records replay state, and deletes a one-time key", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const path: string = join(directory, "vault.sqlite");
    const first: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    const second: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    try {
      const agent: StoredAgentKey = await first.keys.getOrCreateAgent(
        "bob",
        "2026-08-10T17:00:00.000Z",
        "2026-11-08T17:00:00.000Z",
      );
      const created: readonly StoredPrekey[] = await first.keys.replenishPrekeys(
        agent.certificate.agentId,
        "one_time",
        1,
        "2026-08-10T17:00:00.000Z",
        "2026-09-09T17:00:00.000Z",
      );
      const prekey: StoredPrekey | undefined = created[0];
      if (prekey === undefined) throw new Error("Expected one-time prekey");
      const input: CacheDecryptedInput = {
        expiresAt: "2026-09-09T17:00:00.000Z",
        messageId: "22222222-2222-4222-8222-222222222222",
        pairCounter: 1,
        plaintext: "cached endpoint plaintext",
        prekeyId: prekey.certificate.prekeyId,
        recipientId: "bob",
        senderId: "alice",
        tenantId: "11111111-1111-4111-8111-111111111111",
        verifiedAt: "2026-08-10T17:01:00.000Z",
      };
      const cached: CachedMessage = first.cacheDecryptedAndConsumePrekey(input);
      expect(cached.plaintext).toBe(input.plaintext);
      const consumedPrekey: StoredPrekey | null = first.keys.getPrekey(input.prekeyId);
      if (consumedPrekey === null) throw new Error("Expected consumed prekey row");
      expect(consumedPrekey.privateKey).toBeNull();
      expect(second.cacheDecryptedAndConsumePrekey(input).plaintext).toBe(input.plaintext);
      expect(
        (): CachedMessage =>
          second.cacheDecryptedAndConsumePrekey({
            ...input,
            messageId: "33333333-3333-4333-8333-333333333333",
          }),
      ).toThrow("replay detected");
      expect(first.purgeCachedMessages([input.messageId])).toBe(1);
      expect(first.getCachedMessage(input.messageId)).toBeNull();
    } finally {
      first.close();
      second.close();
    }
  });
});

test("rejects a vault schema newer than the running binary", async (): Promise<void> => {
  await withTempDirectory((directory: string): void => {
    const path: string = join(directory, "future.sqlite");
    mkdirSync(directory, { recursive: true });
    const database: Database = new Database(path, { create: true, readwrite: true });
    database.exec("PRAGMA user_version = 4");
    database.close(false);
    expect((): LocalE2eeVault => new LocalE2eeVault(path, "linux")).toThrow("newer");
  });
});
