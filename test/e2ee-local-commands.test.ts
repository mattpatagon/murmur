import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Instant } from "../src/domain/value-objects.js";
import {
  listLocalPeerTrust,
  localE2eeFingerprint,
  localE2eeStatus,
  trustPeerFingerprint,
} from "../src/e2ee/local-commands.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { LocalPeerTrustSummary } from "../src/e2ee/local-commands.js";
import type { StoredRootKey } from "../src/e2ee/local-vault-rows.js";

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
