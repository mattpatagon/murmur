import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CacheDecryptedInput, LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type {
  CachedMessage,
  ExpectedPeerRoot,
  OutboxItem,
  PeerPin,
  SentReceipt,
  StoredAgentKey,
  StoredPrekey,
  StoredRootKey,
} from "../src/e2ee/local-vault-rows.js";
import {
  defaultE2eeVaultPath,
  vaultDirectoryPath,
  windowsVaultAclArguments,
  windowsVaultDirectoryAclArguments,
} from "../src/e2ee/vault-paths.js";

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
  expect(vaultDirectoryPath("C:\\Users\\alice\\vault\\e2ee.sqlite", "win32")).toBe(
    "C:\\Users\\alice\\vault",
  );
  expect(vaultDirectoryPath("/home/alice/vault/e2ee.sqlite", "linux")).toBe("/home/alice/vault");
  expect((): string => vaultDirectoryPath("relative.sqlite", "linux")).toThrow("must be absolute");
  expect((): string => vaultDirectoryPath("/vault.sqlite", "linux")).toThrow(
    "dedicated non-root directory",
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
  expect(
    windowsVaultDirectoryAclArguments("C:\\vault", {
      USERDOMAIN: "WORKSTATION",
      USERNAME: "alice",
    }),
  ).toEqual([
    "C:\\vault",
    "/inheritance:r",
    "/grant:r",
    // biome-ignore lint/security/noSecrets: This is a public Windows ACL fixture, not credential material.
    "WORKSTATION\\alice:(OI)(CI)(F)",
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
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar: string = `${path}${suffix}`;
        if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    } finally {
      first.close();
      second.close();
    }
  });
});

test("finalizes statements and truncates sidecars before strict close", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const path: string = join(directory, "vault.sqlite");
    const moved: string = join(directory, "closed-vault.sqlite");
    const vault: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    await vault.keys.getOrCreateRoot("2026-08-10T17:00:00.000Z");
    expect(vault.keys.getRoot()).not.toBeNull();
    vault.close();
    renameSync(path, moved);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
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
      const expected: ExpectedPeerRoot = vault.keys.expectPeerRoot({
        agentId: "machine:codex:other:carol",
        rootKeyId: root.rootKeyId,
        tenantId: tofu.tenantId,
        verifiedAt: tofu.verifiedAt,
      });
      expect(expected.rootKeyId).toBe(root.rootKeyId);
      const expectedPin: PeerPin = await vault.keys.pinPeer({
        ...tofu,
        agentId: expected.agentId,
        verificationMode: "strict",
      });
      expect(expectedPin.verificationMode).toBe("strict");
      expect(vault.keys.getExpectedPeerRoot(tofu.tenantId, expected.agentId)).toBeNull();
    } finally {
      vault.close();
    }
  });
});

test("rotates expired agent keys while retaining prekey generation identity through expiry", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
    try {
      const first: StoredAgentKey = await vault.keys.getOrCreateAgent(
        "alice",
        "2026-08-10T17:00:00.000Z",
        "2026-08-11T17:00:00.000Z",
      );
      const prekeys: readonly StoredPrekey[] = await vault.keys.replenishPrekeys(
        "alice",
        "fallback",
        1,
        "2026-08-10T17:00:00.000Z",
        "2026-08-11T17:00:00.000Z",
      );
      const beforeExpiry: StoredAgentKey = await vault.keys.getOrCreateAgent(
        "alice",
        "2026-08-11T16:59:59.000Z",
        "2026-11-09T16:59:59.000Z",
      );
      expect(beforeExpiry.certificate.signingKeyId).toBe(first.certificate.signingKeyId);
      const rotated: StoredAgentKey = await vault.keys.getOrCreateAgent(
        "alice",
        "2026-08-11T17:00:00.000Z",
        "2026-11-09T17:00:00.000Z",
      );
      expect(rotated.certificate.signingKeyId).not.toBe(first.certificate.signingKeyId);
      const proactive: StoredAgentKey = await vault.keys.getOrCreateAgent(
        "proactive",
        "2026-08-10T17:00:00.000Z",
        "2026-11-08T17:00:00.000Z",
      );
      const proactivelyRotated: StoredAgentKey = await vault.keys.getOrCreateAgent(
        "proactive",
        "2026-10-10T17:00:00.000Z",
        "2027-01-08T17:00:00.000Z",
        "2026-11-09T17:00:00.000Z",
      );
      expect(proactivelyRotated.certificate.signingKeyId).not.toBe(
        proactive.certificate.signingKeyId,
      );
      const oldPrekey: StoredPrekey | undefined = prekeys[0];
      if (oldPrekey === undefined) throw new Error("Expected old fallback prekey");
      const retained: StoredPrekey | null = vault.keys.getPrekey(oldPrekey.certificate.prekeyId);
      if (retained === null) throw new Error("Expected retained old fallback prekey");
      expect(retained.certificate.agentSigningKeyId).toBe(first.certificate.signingKeyId);
      expect(retained.privateKey).not.toBeNull();
      expect(vault.keys.purgeExpiredPrivatePrekeys("2026-08-11T17:00:00.000Z")).toBe(1);
      const purged: StoredPrekey | null = vault.keys.getPrekey(oldPrekey.certificate.prekeyId);
      if (purged === null) throw new Error("Expected purged fallback prekey row");
      expect(purged.privateKey).toBeNull();
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
        threadId: "thread-1",
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
          threadId: first.threadId,
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
            threadId: "thread-2",
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
      const finalClaimId: string = "22222222-2222-4222-8222-222222222222";
      vault.setOutboxEnvelope(first.logicalId, finalClaimId, '{"ciphertext":"replacement"}');
      const receipt: SentReceipt = vault.commitOutbox(
        first.logicalId,
        "2026-09-09T17:00:00.000Z",
        "strict",
      );
      expect(receipt.claimId).toBe(finalClaimId);
      expect(vault.getOutbox(first.logicalId)).toBeNull();
      expect(vault.getSentReceipt(first.logicalId)).toEqual(receipt);
      const second: OutboxItem = vault.beginOutbox({
        createdAt: "2026-08-10T17:01:00.000Z",
        logicalId: "logical-2",
        plaintext: "second secret",
        plaintextDigest: fixedDigest(2),
        recipientId: first.recipientId,
        senderId: first.senderId,
        tenantId: first.tenantId,
        threadId: "thread-2",
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
        tenantSequence: 1,
        tenantId: "11111111-1111-4111-8111-111111111111",
        verifiedAt: "2026-08-10T17:01:00.000Z",
        wireDigest: new Uint8Array(32).fill(9),
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

test("upgrades version-four prekeys with their original signing generation", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const path: string = join(directory, "upgrade.sqlite");
    const original: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    const agent: StoredAgentKey = await original.keys.getOrCreateAgent(
      "alice",
      "2026-08-10T17:00:00.000Z",
      "2026-11-08T17:00:00.000Z",
    );
    const prekeys: readonly StoredPrekey[] = await original.keys.replenishPrekeys(
      "alice",
      "one_time",
      1,
      "2026-08-10T17:00:00.000Z",
      "2026-09-09T17:00:00.000Z",
    );
    original.close();
    const prekey: StoredPrekey | undefined = prekeys[0];
    if (prekey === undefined) throw new Error("Expected upgrade prekey");
    const legacy: Database = new Database(path, { create: false, readwrite: true });
    legacy.exec(`
      DROP INDEX agent_keys_retired_cleanup;
      DROP TABLE orchestration_routes;
      DROP TABLE agent_key_revocations;
      DROP TABLE active_tenant_binding;
      DROP TABLE peer_root_expectations;
      DROP INDEX prekeys_signing_generation;
      ALTER TABLE prekeys DROP COLUMN agent_signing_key_id;
      ALTER TABLE agent_keys DROP COLUMN retired_at;
      PRAGMA user_version = 4;
    `);
    legacy.close(false);
    const upgraded: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    try {
      const restored: StoredPrekey | null = upgraded.keys.getPrekey(prekey.certificate.prekeyId);
      if (restored === null) throw new Error("Expected upgraded prekey");
      expect(restored.certificate.agentSigningKeyId).toBe(agent.certificate.signingKeyId);
      expect(restored.privateKey).toEqual(prekey.privateKey);
    } finally {
      upgraded.close();
    }
  });
});

test("upgrades a populated version-six vault with an empty active tenant binding", async (): Promise<void> => {
  await withTempDirectory((directory: string): void => {
    const path: string = join(directory, "tenant-binding-upgrade.sqlite");
    const original: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    original.settings.bindActiveTenant(
      "00000000-0000-4000-8000-000000000010",
      "2026-08-10T20:00:00.000Z",
    );
    original.close();
    const legacy: Database = new Database(path, { create: false, readwrite: true });
    legacy.exec(`
      DROP INDEX agent_keys_retired_cleanup;
      DROP TABLE orchestration_routes;
      DROP TABLE agent_key_revocations;
      DROP TABLE active_tenant_binding;
      ALTER TABLE agent_keys DROP COLUMN retired_at;
      PRAGMA user_version = 6;
    `);
    legacy.close(false);
    const upgraded: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    try {
      expect(upgraded.settings.getActiveTenant()).toBeNull();
      expect(
        upgraded.settings.bindActiveTenant(
          "00000000-0000-4000-8000-000000000011",
          "2026-08-10T20:01:00.000Z",
        ),
      ).toEqual({
        boundAt: "2026-08-10T20:01:00.000Z",
        tenantId: "00000000-0000-4000-8000-000000000011",
      });
      expect((): unknown =>
        upgraded.settings.bindActiveTenant(
          "00000000-0000-4000-8000-000000000012",
          "2026-08-10T20:02:00.000Z",
        ),
      ).toThrow("already bound to another tenant");
    } finally {
      upgraded.close();
    }
  });
});

test("rejects a vault schema newer than the running binary", async (): Promise<void> => {
  await withTempDirectory((directory: string): void => {
    const path: string = join(directory, "future.sqlite");
    mkdirSync(directory, { recursive: true });
    const database: Database = new Database(path, { create: true, readwrite: true });
    database.exec("PRAGMA user_version = 12");
    database.close(false);
    expect((): LocalE2eeVault => new LocalE2eeVault(path, "linux")).toThrow("newer");
  });
});
