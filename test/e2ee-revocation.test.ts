import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  verifyAgentKeyRevocation,
} from "../src/e2ee/certificates.js";
import { verifyHostedPublicBundle } from "../src/e2ee/hosted-validation.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { StoredAgentKey, StoredPrekey } from "../src/e2ee/local-vault-rows.js";
import type { BoxKeyPair, SigningKeyPair } from "../src/e2ee/protocol.js";
import {
  type AgentKeyRevocationDto,
  type PublicAgentKeyBundleDto,
  parsePublicBundleDto,
  publicBundleToDto,
} from "../src/e2ee/wire-contracts.js";

const AGENT_ID: string = "machine:codex:repo:alice";
const NOW: Date = new Date("2026-08-10T20:00:00.000Z");

function seed(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

async function agentCertificate(
  root: SigningKeyPair,
  agent: SigningKeyPair,
  createdAt: string,
): Promise<AgentKeyCertificate> {
  return await createAgentKeyCertificate(
    {
      agentId: AGENT_ID,
      createdAt,
      expiresAt: "2026-11-08T20:00:00.000Z",
      rootKeyId: await rootKeyId(root.publicKey),
      signingKeyId: await agentSigningKeyId(agent.publicKey),
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
}

async function prekeyCertificate(
  agent: SigningKeyPair,
  certificate: AgentKeyCertificate,
  prekeyClass: "fallback" | "one_time",
  seedValue: number,
): Promise<PrekeyCertificate> {
  const prekey: BoxKeyPair = await createBoxKeyPair(seed(seedValue));
  return await createPrekeyCertificate(
    {
      agentId: AGENT_ID,
      agentSigningKeyId: certificate.signingKeyId,
      createdAt: certificate.createdAt,
      expiresAt: "2026-09-16T20:00:00.000Z",
      prekeyClass,
      prekeyId: await prekeyId(prekey.publicKey),
      prekeyPublicKey: prekey.publicKey,
    },
    agent.privateKey,
  );
}

test("root-signed agent revocations bind identity, signing generation, time, and reason", async (): Promise<void> => {
  const root: SigningKeyPair = await createSigningKeyPair(seed(1));
  const agent: SigningKeyPair = await createSigningKeyPair(seed(2));
  const certificate: AgentKeyCertificate = await agentCertificate(
    root,
    agent,
    "2026-08-10T19:00:00.000Z",
  );
  const revocation: AgentKeyRevocation = await createAgentKeyRevocation(
    {
      agentId: AGENT_ID,
      reason: "Signing key may have been copied",
      revokedAt: "2026-08-10T19:30:00.000Z",
      revokedSigningKeyId: certificate.signingKeyId,
      rootKeyId: certificate.rootKeyId,
    },
    root.privateKey,
  );
  await expect(
    verifyAgentKeyRevocation(revocation, root.publicKey, AGENT_ID, NOW),
  ).resolves.toBeUndefined();
  await expect(
    verifyAgentKeyRevocation(
      { ...revocation, reason: "Relabeled reason" },
      root.publicKey,
      AGENT_ID,
      NOW,
    ),
  ).rejects.toThrow("signature is invalid");
  await expect(
    verifyAgentKeyRevocation(revocation, root.publicKey, "mallory", NOW),
  ).rejects.toThrow("identity mismatch");
});

test("hosted public bundles accept monotonic historical revocations but reject an active revoked key", async (): Promise<void> => {
  const root: SigningKeyPair = await createSigningKeyPair(seed(11));
  const oldAgent: SigningKeyPair = await createSigningKeyPair(seed(12));
  const replacementAgent: SigningKeyPair = await createSigningKeyPair(seed(13));
  const oldCertificate: AgentKeyCertificate = await agentCertificate(
    root,
    oldAgent,
    "2026-08-10T18:00:00.000Z",
  );
  const replacementCertificate: AgentKeyCertificate = await agentCertificate(
    root,
    replacementAgent,
    "2026-08-10T19:40:00.000Z",
  );
  const revocation: AgentKeyRevocation = await createAgentKeyRevocation(
    {
      agentId: AGENT_ID,
      reason: "Compromise response",
      revokedAt: "2026-08-10T19:30:00.000Z",
      revokedSigningKeyId: oldCertificate.signingKeyId,
      rootKeyId: oldCertificate.rootKeyId,
    },
    root.privateKey,
  );
  const replacementFallback: PrekeyCertificate = await prekeyCertificate(
    replacementAgent,
    replacementCertificate,
    "fallback",
    14,
  );
  const replacementOneTime: PrekeyCertificate = await prekeyCertificate(
    replacementAgent,
    replacementCertificate,
    "one_time",
    15,
  );
  const replacementBundle: PublicAgentKeyBundleDto = publicBundleToDto(
    root.publicKey,
    replacementCertificate,
    replacementFallback,
    [replacementOneTime],
    [revocation],
  );
  await expect(
    verifyHostedPublicBundle(AGENT_ID, replacementBundle, NOW, 20),
  ).resolves.toMatchObject({ agentKeyRevocations: [{ reason: "Compromise response" }] });
  expect(parsePublicBundleDto(replacementBundle).agentKeyRevocations).toEqual([revocation]);

  const oldFallback: PrekeyCertificate = await prekeyCertificate(
    oldAgent,
    oldCertificate,
    "fallback",
    16,
  );
  const activeRevokedBundle: PublicAgentKeyBundleDto = publicBundleToDto(
    root.publicKey,
    oldCertificate,
    oldFallback,
    [],
    [revocation],
  );
  await expect(verifyHostedPublicBundle(AGENT_ID, activeRevokedBundle, NOW, 20)).rejects.toThrow(
    "validation failed",
  );
  const revocations: NonNullable<PublicAgentKeyBundleDto["agent_key_revocations"]> =
    replacementBundle.agent_key_revocations ?? [];
  const first: AgentKeyRevocationDto | undefined = revocations[0];
  if (first === undefined) throw new Error("Expected a revocation fixture");
  await expect(
    verifyHostedPublicBundle(
      AGENT_ID,
      { ...replacementBundle, agent_key_revocations: [{ ...first, signature: "A".repeat(86) }] },
      NOW,
      20,
    ),
  ).rejects.toThrow("validation failed");
});

test("local revocation persists before rotation and retires the revoked generation prekeys", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-revoke-"));
  const path: string = join(directory, "vault.sqlite");
  try {
    const vault: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    let revokedPrekeyId: string;
    let revokedSigningKeyId: string;
    try {
      const original: StoredAgentKey = await vault.keys.getOrCreateAgent(
        AGENT_ID,
        "2026-08-10T19:00:00.000Z",
        "2026-11-08T19:00:00.000Z",
      );
      revokedSigningKeyId = original.certificate.signingKeyId;
      const prekeys: readonly StoredPrekey[] = await vault.keys.replenishPrekeys(
        AGENT_ID,
        "one_time",
        1,
        "2026-08-10T19:00:00.000Z",
        "2026-09-16T20:00:00.000Z",
      );
      const prekey: StoredPrekey | undefined = prekeys[0];
      if (prekey === undefined) throw new Error("Expected prekey fixture");
      revokedPrekeyId = prekey.certificate.prekeyId;
      await vault.keys.revokeCurrentAgentKey(
        AGENT_ID,
        "Crash-safe compromise response",
        NOW.toISOString(),
      );
      expect(vault.keys.getPrekey(revokedPrekeyId)).toMatchObject({ privateKey: null });
      const replacement: StoredAgentKey = await vault.keys.getOrCreateAgent(
        AGENT_ID,
        NOW.toISOString(),
        "2026-11-08T20:00:00.000Z",
      );
      expect(replacement.certificate.signingKeyId).not.toBe(revokedSigningKeyId);
    } finally {
      vault.close();
    }
    const reopened: LocalE2eeVault = new LocalE2eeVault(path, "linux");
    try {
      expect(reopened.keys.listAgentKeyRevocations(AGENT_ID)).toMatchObject([
        { revokedSigningKeyId },
      ]);
      expect(reopened.keys.getPrekey(revokedPrekeyId)).toMatchObject({ privateKey: null });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
