import { Database, type Statement } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_RETAINED_AGENTS } from "../src/domain/lifecycle-values.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { StoredAgentKey, StoredPrekey } from "../src/e2ee/local-vault-rows.js";

test("upgrades a populated version-ten vault with identity retirement", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-upgrade-"));
  const path: string = join(directory, "vault.sqlite");
  const original: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  try {
    await original.keys.getOrCreateAgent(
      "retired-upgrade-agent",
      "2026-08-10T17:00:00.000Z",
      "2026-11-08T17:00:00.000Z",
    );
  } finally {
    original.close();
  }
  const legacy: Database = new Database(path, { create: false, readwrite: true });
  legacy.exec(`
    DROP INDEX agent_keys_retired_cleanup;
    ALTER TABLE agent_keys DROP COLUMN retired_at;
    PRAGMA user_version = 10;
  `);
  legacy.close(false);

  const upgraded: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  try {
    upgraded.keys.retireAgent("retired-upgrade-agent", "2026-08-11T17:00:00.000Z");
    upgraded.purgeExpired("2026-09-10T17:00:00.000Z");
    expect(upgraded.keys.getAgent("retired-upgrade-agent")).toBeNull();
  } finally {
    upgraded.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("purges expired local agent identities and their prekeys", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-prune-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    const expired: StoredAgentKey = await vault.keys.getOrCreateAgent(
      "expired-session-agent",
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    );
    const expiredPrekeys: readonly StoredPrekey[] = await vault.keys.replenishPrekeys(
      expired.certificate.agentId,
      "fallback",
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-02-07T00:00:00.000Z",
    );
    const retained: StoredAgentKey = await vault.keys.getOrCreateAgent(
      "live-session-agent",
      "2026-03-15T00:00:00.000Z",
      "2026-06-13T00:00:00.000Z",
    );
    const expiredPrekey: StoredPrekey | undefined = expiredPrekeys[0];
    if (expiredPrekey === undefined) throw new Error("Expected an expired prekey");

    vault.purgeExpired("2026-04-02T00:00:00.000Z");

    expect(vault.keys.getAgent(expired.certificate.agentId)).toBeNull();
    expect(vault.keys.getPrekey(expiredPrekey.certificate.prekeyId)).toBeNull();
    expect(vault.keys.getAgent(retained.certificate.agentId)).not.toBeNull();
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("retains an expired sender identity while its outbox is pending", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-outbox-prune-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    await vault.keys.getOrCreateAgent(
      "pending-session-agent",
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    );
    vault.beginOutbox({
      createdAt: "2026-01-02T00:00:00.000Z",
      logicalId: "pending-logical-id",
      plaintext: "pending message",
      plaintextDigest: new Uint8Array(32),
      recipientId: "recipient-agent",
      senderId: "pending-session-agent",
      tenantId: "11111111-1111-4111-8111-111111111111",
      threadId: "pending-thread",
    });

    vault.purgeExpired("2026-04-02T00:00:00.000Z");

    expect(vault.keys.getAgent("pending-session-agent")).not.toBeNull();
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("retired identities remain decryptable for retention and are then reclaimed", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-retire-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    await vault.keys.getOrCreateAgent(
      "completed-session-agent",
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    );
    vault.keys.retireAgent("completed-session-agent", "2026-01-02T00:00:00.000Z");

    vault.purgeExpired("2026-01-31T23:59:59.999Z");
    expect(vault.keys.getAgent("completed-session-agent")).not.toBeNull();

    vault.purgeExpired("2026-02-01T00:00:00.000Z");
    expect(vault.keys.getAgent("completed-session-agent")).toBeNull();
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("reusing or rotating a retired identity reactivates it", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-reactivate-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    const original: StoredAgentKey = await vault.keys.getOrCreateAgent(
      "returning-session-agent",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    );
    vault.keys.retireAgent("returning-session-agent", "2026-01-02T00:00:00.000Z");

    const reused: StoredAgentKey = await vault.keys.getOrCreateAgent(
      "returning-session-agent",
      "2026-01-03T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(reused.certificate.signingKeyId).toBe(original.certificate.signingKeyId);
    vault.purgeExpired("2026-02-01T00:00:00.000Z");
    expect(vault.keys.getAgent("returning-session-agent")).not.toBeNull();

    vault.keys.retireAgent("returning-session-agent", "2026-02-02T00:00:00.000Z");
    const rotated: StoredAgentKey = await vault.keys.getOrCreateAgent(
      "returning-session-agent",
      "2026-02-03T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-02-03T00:00:00.000Z",
      true,
    );
    expect(rotated.certificate.signingKeyId).not.toBe(original.certificate.signingKeyId);
    vault.purgeExpired("2026-03-04T00:00:00.000Z");
    const retained: StoredAgentKey | null = vault.keys.getAgent("returning-session-agent");
    if (retained === null) throw new Error("Expected the rotated identity to remain active");
    expect(retained.certificate.signingKeyId).toBe(rotated.certificate.signingKeyId);
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("local E2E capacity accepts ten thousand identities and rejects the next", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-capacity-"));
  const path: string = join(directory, "vault.sqlite");
  const original: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  try {
    await original.keys.getOrCreateAgent(
      "session-agent-0",
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    );
  } finally {
    original.close();
  }
  const database: Database = new Database(path, { create: false, readwrite: true });
  try {
    using insert: Statement<unknown, [string, string]> = database.prepare(`
      INSERT INTO agent_keys(
        agent_id, root_key_id, signing_key_id, public_key, private_key,
        created_at, expires_at, certificate_signature
      )
      SELECT ?, root_key_id, ?, public_key, private_key,
             created_at, expires_at, certificate_signature
      FROM agent_keys WHERE agent_id = 'session-agent-0'
    `);
    database.exec("BEGIN IMMEDIATE");
    for (let index: number = 1; index < MAX_RETAINED_AGENTS; index += 1) {
      insert.run(`session-agent-${index}`, `seeded-signing-key-${index}`);
    }
    database.exec("COMMIT");
  } finally {
    database.close(false);
  }

  const full: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  try {
    expect(full.keys.listAgents()).toHaveLength(MAX_RETAINED_AGENTS);
    await expect(
      full.keys.getOrCreateAgent(
        "session-agent-over-capacity",
        "2026-01-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
      ),
    ).rejects.toThrow("Local E2E agent key capacity reached");
    expect(full.keys.listAgents()).toHaveLength(MAX_RETAINED_AGENTS);
  } finally {
    full.close();
    rmSync(directory, { force: true, recursive: true });
  }
}, 10_000);
