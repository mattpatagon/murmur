import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Instant } from "../src/domain/value-objects.js";
import {
  exportLocalPublicIdentity,
  listLocalPeerTrust,
  localE2eeFingerprint,
  localE2eeStatus,
  replenishLocalPrekeys,
  rotateLocalAgentKey,
  trustPeerFingerprint,
} from "../src/e2ee/local-commands.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type {
  LocalPeerTrustSummary,
  LocalPrekeyReplenishment,
  LocalPublicIdentityExport,
} from "../src/e2ee/local-commands.js";
import type { StoredAgentKey, StoredPrekey, StoredRootKey } from "../src/e2ee/local-vault-rows.js";
import {
  AgentKeyCertificateDtoSchema,
  PrekeyCertificateDtoSchema,
} from "../src/e2ee/wire-contracts.js";

test("reports local status and stages an exact strict fingerprint without creating keys", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-local-command-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    expect(localE2eeStatus(vault)).toEqual({
      initialized: false,
      peer_count: 0,
      root_key_id: null,
    });
    expect((): string => localE2eeFingerprint(vault)).toThrow("not initialized");
    const root: StoredRootKey = await vault.keys.getOrCreateRoot("2026-08-10T19:00:00.000Z");
    expect(localE2eeFingerprint(vault)).toBe(root.rootKeyId);
    const trusted: LocalPeerTrustSummary = trustPeerFingerprint(
      vault,
      {
        agentId: "other-machine:codex:other-repo:alice",
        rootKeyId: `mrk_${"A".repeat(43)}`,
        tenantId: "11111111-1111-4111-8111-111111111111",
      },
      Instant.parse("2026-08-10T19:01:00.000Z"),
    );
    expect(trusted.verification).toBe("pending_strict");
    expect(listLocalPeerTrust(vault)).toEqual([trusted]);
    expect(localE2eeStatus(vault).peer_count).toBe(1);
    expect(
      (): LocalPeerTrustSummary =>
        trustPeerFingerprint(
          vault,
          {
            agentId: trusted.agent_id,
            rootKeyId: `mrk_${"B".repeat(43)}`,
            tenantId: trusted.tenant_id,
          },
          Instant.parse("2026-08-10T19:02:00.000Z"),
        ),
    ).toThrow("requires an audited reset");
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("replenishes bounded prekeys and rotates one agent generation concurrently", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-key-command-"));
  const path: string = join(directory, "vault.sqlite");
  const first: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  const second: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  const agentId: string = "machine-a:codex:repo-a:alice";
  try {
    const replenished: LocalPrekeyReplenishment = await replenishLocalPrekeys(
      first,
      agentId,
      Instant.parse("2026-08-10T19:00:00.000Z"),
    );
    expect(replenished).toMatchObject({ fallback_available: 1, one_time_available: 20 });
    expect(
      await replenishLocalPrekeys(second, agentId, Instant.parse("2026-08-10T19:01:00.000Z")),
    ).toEqual(replenished);
    const previousKeyId: string = replenished.agent_key_id;
    const rotations: readonly [
      Awaited<ReturnType<typeof rotateLocalAgentKey>>,
      Awaited<ReturnType<typeof rotateLocalAgentKey>>,
    ] = await Promise.all([
      rotateLocalAgentKey(first, agentId, Instant.parse("2026-08-11T19:00:00.000Z")),
      rotateLocalAgentKey(second, agentId, Instant.parse("2026-08-11T19:00:00.000Z")),
    ]);
    expect(rotations[0].signing_key_id).toBe(rotations[1].signing_key_id);
    expect(rotations[0].signing_key_id).not.toBe(previousKeyId);
    const afterRotation: LocalPrekeyReplenishment = await replenishLocalPrekeys(
      first,
      agentId,
      Instant.parse("2026-08-11T19:01:00.000Z"),
    );
    expect(afterRotation).toMatchObject({
      agent_key_id: rotations[0].signing_key_id,
      fallback_available: 1,
      one_time_available: 20,
    });
  } finally {
    second.close();
    first.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("exports only bounded public identity material without creating or leaking keys", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-public-export-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"), "linux");
  try {
    expect((): LocalPublicIdentityExport => exportLocalPublicIdentity(vault)).toThrow(
      "not initialized",
    );
    const root: StoredRootKey = await vault.keys.getOrCreateRoot("2026-08-10T19:00:00.000Z");
    expect(exportLocalPublicIdentity(vault).agents).toEqual([]);
    const agent: StoredAgentKey = await vault.keys.getOrCreateAgent(
      "machine-a:codex:repo-a:alice",
      "2026-08-10T19:00:00.000Z",
      "2026-11-08T19:00:00.000Z",
    );
    const prekeys: readonly StoredPrekey[] = await vault.keys.replenishPrekeys(
      agent.certificate.agentId,
      "one_time",
      2,
      "2026-08-10T19:01:00.000Z",
      "2026-09-16T19:01:00.000Z",
    );
    const exported: LocalPublicIdentityExport = exportLocalPublicIdentity(vault);
    expect(exported.protocol).toBe("murmur-e2ee-v1");
    expect(exported.root_key_id).toBe(root.rootKeyId);
    expect(exported.agents).toHaveLength(1);
    const exportedAgent: LocalPublicIdentityExport["agents"][number] | undefined =
      exported.agents[0];
    if (exportedAgent === undefined) throw new Error("Expected an exported agent identity");
    expect(AgentKeyCertificateDtoSchema.parse(exportedAgent.agent_certificate)).toEqual(
      exportedAgent.agent_certificate,
    );
    exportedAgent.prekeys.forEach((prekey: unknown): void => {
      PrekeyCertificateDtoSchema.parse(prekey);
    });
    const serialized: string = JSON.stringify(exported);
    expect(serialized).not.toContain(Buffer.from(root.privateKey).toString("base64url"));
    expect(serialized).not.toContain(Buffer.from(agent.privateKey).toString("base64url"));
    for (const prekey of prekeys) {
      if (prekey.privateKey === null) throw new Error("Expected a generated private prekey");
      expect(serialized).not.toContain(Buffer.from(prekey.privateKey).toString("base64url"));
    }
  } finally {
    vault.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
