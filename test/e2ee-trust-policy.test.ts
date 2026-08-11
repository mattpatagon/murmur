import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSigningKeyPair, rootKeyId } from "../src/e2ee/certificates.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { PeerPin } from "../src/e2ee/local-vault-rows.js";
import type { StoredTrustPolicyState } from "../src/e2ee/local-vault-trust.js";
import type { SigningKeyPair } from "../src/e2ee/protocol.js";
import {
  createOrganizationTrustPolicy,
  type OrganizationTrustBinding,
  type OrganizationTrustPolicy,
  type OrganizationTrustPolicyDto,
  type OrganizationTrustRevocation,
  parseSerializedTrustPolicy,
  serializeTrustPolicy,
  trustIssuerKeyId,
  trustPolicyToDto,
  verifyOrganizationTrustPolicy,
} from "../src/e2ee/trust-policy.js";

const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const CREATED_AT: string = "2026-08-10T17:00:00.000Z";
const EXPIRES_AT: string = "2026-09-09T17:00:00.000Z";
const NOW: Date = new Date("2026-08-10T18:00:00.000Z");

function bytes(length: number, start: number): Uint8Array {
  const result: Uint8Array = new Uint8Array(length);
  for (let index: number = 0; index < result.byteLength; index += 1) {
    result[index] = (start + index) % 256;
  }
  return result;
}

function withTempDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-trust-"));
  return Promise.resolve()
    .then((): Promise<void> | void => run(directory))
    .finally((): void => {
      rmSync(directory, { force: true, recursive: true });
    });
}

async function binding(agentId: string, seedStart: number): Promise<OrganizationTrustBinding> {
  const root: SigningKeyPair = await createSigningKeyPair(bytes(32, seedStart));
  return {
    agentId,
    rootKeyId: await rootKeyId(root.publicKey),
    rootPublicKey: root.publicKey,
  };
}

async function policy(
  issuer: SigningKeyPair,
  version: number,
  bindings: readonly OrganizationTrustBinding[],
  revokedRootIds: readonly string[] = [],
): Promise<OrganizationTrustPolicy> {
  return createOrganizationTrustPolicy(
    {
      bindings,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      issuerKeyId: await trustIssuerKeyId(issuer.publicKey),
      issuerPublicKey: issuer.publicKey,
      revocations: revokedRootIds.map(
        (rootId: string): OrganizationTrustRevocation => ({
          reason: "continuity rotation",
          revokedAt: "2026-08-10T17:30:00.000Z",
          rootKeyId: rootId,
        }),
      ),
      tenantId: TENANT_ID,
      version,
    },
    issuer.privateKey,
  );
}

test("signs a canonical public-only trust file and rejects tampering", async (): Promise<void> => {
  const issuer: SigningKeyPair = await createSigningKeyPair(bytes(32, 1));
  const alice: OrganizationTrustBinding = await binding("alice", 33);
  const bob: OrganizationTrustBinding = await binding("bob", 65);
  const created: OrganizationTrustPolicy = await policy(issuer, 1, [bob, alice]);
  expect(created.bindings.map((item: OrganizationTrustBinding): string => item.agentId)).toEqual([
    "alice",
    "bob",
  ]);
  const serialized: string = serializeTrustPolicy(created);
  expect(serialized).not.toContain(Buffer.from(issuer.privateKey).toString("base64url"));
  const parsed: OrganizationTrustPolicy = parseSerializedTrustPolicy(serialized);
  const issuerId: string = await trustIssuerKeyId(issuer.publicKey);
  await expect(verifyOrganizationTrustPolicy(parsed, issuerId, NOW)).resolves.toBeUndefined();

  const dto: OrganizationTrustPolicyDto = trustPolicyToDto(parsed);
  expect(
    (): OrganizationTrustPolicy =>
      parseSerializedTrustPolicy(JSON.stringify({ ...dto, private_key: "forbidden" })),
  ).toThrow();
  const tampered: OrganizationTrustPolicy = {
    ...parsed,
    signature: parsed.signature.map((value: number, index: number): number =>
      index === 0 ? value ^ 1 : value,
    ),
  };
  await expect(verifyOrganizationTrustPolicy(tampered, issuerId, NOW)).rejects.toThrow(
    "signature is invalid",
  );
  await expect(verifyOrganizationTrustPolicy(parsed, `mti_${"A".repeat(43)}`, NOW)).rejects.toThrow(
    "fingerprint mismatch",
  );
});

test("persists monotonic organization trust and requires explicit continuity revocation", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
    try {
      const issuer: SigningKeyPair = await createSigningKeyPair(bytes(32, 2));
      const issuerId: string = await trustIssuerKeyId(issuer.publicKey);
      const oldAlice: OrganizationTrustBinding = await binding("alice", 34);
      const newAlice: OrganizationTrustBinding = await binding("alice", 66);
      const first: OrganizationTrustPolicy = await policy(issuer, 1, [oldAlice]);
      const stored: StoredTrustPolicyState = await vault.trust.applyPolicy(first, issuerId, NOW);
      expect(stored.version).toBe(1);
      const firstPin: PeerPin | null = vault.keys.getPin(TENANT_ID, "alice");
      if (firstPin === null) throw new Error("Expected organization pin");
      expect(firstPin.verificationMode).toBe("organization");
      await expect(vault.trust.applyPolicy(first, issuerId, NOW)).rejects.toThrow("must advance");

      const unsafeRotation: OrganizationTrustPolicy = await policy(issuer, 2, [newAlice]);
      await expect(vault.trust.applyPolicy(unsafeRotation, issuerId, NOW)).rejects.toThrow(
        "must revoke the prior root",
      );
      const afterRejectedRotation: StoredTrustPolicyState | null =
        vault.trust.getPolicyState(TENANT_ID);
      if (afterRejectedRotation === null) throw new Error("Expected stored trust policy");
      expect(afterRejectedRotation.version).toBe(1);

      const rotated: OrganizationTrustPolicy = await policy(
        issuer,
        2,
        [newAlice],
        [oldAlice.rootKeyId],
      );
      expect((await vault.trust.applyPolicy(rotated, issuerId, NOW)).version).toBe(2);
      const rotatedPin: PeerPin | null = vault.keys.getPin(TENANT_ID, "alice");
      if (rotatedPin === null) throw new Error("Expected rotated organization pin");
      expect(rotatedPin.rootKeyId).toBe(newAlice.rootKeyId);
      const usablePin: PeerPin | null = vault.keys.getUsablePin(TENANT_ID, "alice", NOW);
      if (usablePin === null) throw new Error("Expected usable organization pin");
      expect(usablePin.rootKeyId).toBe(newAlice.rootKeyId);
      expect((): PeerPin | null =>
        vault.keys.getUsablePin(TENANT_ID, "alice", new Date(EXPIRES_AT)),
      ).toThrow("policy is expired");
      expect(vault.trust.revokedRootIds(TENANT_ID).has(oldAlice.rootKeyId)).toBe(true);
      const revokedPin: PeerPin = {
        agentId: "mallory",
        publicKey: oldAlice.rootPublicKey,
        rootKeyId: oldAlice.rootKeyId,
        tenantId: TENANT_ID,
        verificationMode: "strict",
        verifiedAt: NOW.toISOString(),
      };
      await expect(vault.keys.pinPeer(revokedPin)).rejects.toThrow("is revoked");

      const removedRevocation: OrganizationTrustPolicy = await policy(issuer, 3, [newAlice]);
      await expect(vault.trust.applyPolicy(removedRevocation, issuerId, NOW)).rejects.toThrow(
        "cannot remove a revocation",
      );
      const retained: StoredTrustPolicyState | null = vault.trust.getPolicyState(TENANT_ID);
      if (retained === null) throw new Error("Expected retained trust policy");
      expect(retained.version).toBe(2);

      const bindingRemoved: OrganizationTrustPolicy = await policy(
        issuer,
        3,
        [],
        [oldAlice.rootKeyId],
      );
      await vault.trust.applyPolicy(bindingRemoved, issuerId, NOW);
      expect(vault.keys.getPin(TENANT_ID, "alice")).toBeNull();
    } finally {
      vault.close();
    }
  });
});

test("rejects issuer substitution and upgrades a populated version-one vault", async (): Promise<void> => {
  await withTempDirectory(async (directory: string): Promise<void> => {
    const path: string = join(directory, "vault.sqlite");
    const original: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    original.close();
    const legacyDatabase: Database = new Database(path, { readwrite: true, strict: true });
    legacyDatabase.exec(`
      DROP TABLE orchestration_routes;
      DROP TABLE agent_key_revocations;
      DROP TABLE active_tenant_binding;
      DROP TABLE peer_root_expectations;
      DROP INDEX prekeys_signing_generation;
      ALTER TABLE prekeys DROP COLUMN agent_signing_key_id;
      DROP TABLE trust_policy_revocations;
      DROP TABLE trust_policy_state;
      ALTER TABLE outbox DROP COLUMN claim_id;
      ALTER TABLE outbox DROP COLUMN thread_id;
      DROP TABLE sent_receipts;
      PRAGMA user_version = 1;
    `);
    legacyDatabase.close(false);

    const vault: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    try {
      const issuer: SigningKeyPair = await createSigningKeyPair(bytes(32, 3));
      const replacement: SigningKeyPair = await createSigningKeyPair(bytes(32, 35));
      const alice: OrganizationTrustBinding = await binding("alice", 67);
      const first: OrganizationTrustPolicy = await policy(issuer, 1, [alice]);
      const issuerId: string = await trustIssuerKeyId(issuer.publicKey);
      await vault.trust.applyPolicy(first, issuerId, NOW);
      const replacementPolicy: OrganizationTrustPolicy = await policy(replacement, 2, [alice]);
      await expect(
        vault.trust.applyPolicy(
          replacementPolicy,
          await trustIssuerKeyId(replacement.publicKey),
          NOW,
        ),
      ).rejects.toThrow("requires an audited reset");
      const retained: StoredTrustPolicyState | null = vault.trust.getPolicyState(TENANT_ID);
      if (retained === null) throw new Error("Expected retained trust issuer");
      expect(retained.issuerKeyId).toBe(issuerId);
    } finally {
      vault.close();
    }
  });
});
