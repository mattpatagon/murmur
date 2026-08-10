import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock, Instant } from "../src/domain/value-objects.js";
import { Instant as InstantValue } from "../src/domain/value-objects.js";
import { runE2eeCli, type E2eeCliRuntime } from "../src/e2ee/cli.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { StoredRootKey } from "../src/e2ee/local-vault-rows.js";

const TENANT_ID: string = "00000000-0000-4000-8000-000000000010";
const AGENT_ID: string = "machine-a:codex:repo:1";
const PEER_ID: string = "machine-b:codex:repo:2";
const PEER_FINGERPRINT: string = `mrk_${"C".repeat(43)}`;

class FixedClock implements Clock {
  public now(): Instant {
    return InstantValue.parse("2026-08-10T20:00:00.000Z");
  }
}

function runtime(path: string): E2eeCliRuntime {
  return {
    clock: new FixedClock(),
    createVault: (vaultPath: string): LocalE2eeVault => new LocalE2eeVault(vaultPath, "linux"),
    defaultVaultPath: (): string => path,
    readTrustFile: (_trustPath: string): string => {
      throw new Error("unexpected trust file read");
    },
  };
}

test("local E2E CLI binds trust to the authenticated tenant and exports public data only", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-cli-"));
  const path: string = join(directory, "vault.sqlite");
  const initial: LocalE2eeVault = new LocalE2eeVault(path, "linux");
  let privateRoot: string;
  try {
    initial.settings.bindActiveTenant(TENANT_ID, "2026-08-10T19:59:00.000Z");
    await initial.keys.getOrCreateAgent(
      AGENT_ID,
      "2026-08-10T19:59:00.000Z",
      "2026-11-08T19:59:00.000Z",
    );
    const root: StoredRootKey | null = initial.keys.getRoot();
    if (root === null) throw new Error("Expected a local root key fixture");
    privateRoot = Buffer.from(root.privateKey).toString("base64url");
  } finally {
    initial.close();
  }
  const cliRuntime: E2eeCliRuntime = runtime(path);
  try {
    const status: unknown = JSON.parse(await runE2eeCli(["status"], cliRuntime));
    expect(status).toMatchObject({
      active_tenant_id: TENANT_ID,
      initialized: true,
      peer_count: 0,
    });
    const fingerprint: string = (await runE2eeCli(["fingerprint"], cliRuntime)).trim();
    expect(fingerprint.startsWith("mrk_")).toBe(true);

    const trusted: unknown = JSON.parse(
      await runE2eeCli(
        ["trust", "--agent", PEER_ID, "--fingerprint", PEER_FINGERPRINT],
        cliRuntime,
      ),
    );
    expect(trusted).toMatchObject({
      agent_id: PEER_ID,
      root_key_id: PEER_FINGERPRINT,
      tenant_id: TENANT_ID,
      verification: "pending_strict",
    });
    const peers: unknown = JSON.parse(await runE2eeCli(["peers"], cliRuntime));
    expect(peers).toMatchObject({ peers: [{ agent_id: PEER_ID, tenant_id: TENANT_ID }] });

    const rotated: unknown = JSON.parse(
      await runE2eeCli(["rotate-agent-key", "--agent", AGENT_ID], cliRuntime),
    );
    expect(rotated).toMatchObject({ agent_id: AGENT_ID, root_key_id: fingerprint });
    const replenished: unknown = JSON.parse(
      await runE2eeCli(["replenish", "--agent", AGENT_ID], cliRuntime),
    );
    expect(replenished).toMatchObject({ fallback_available: 1, one_time_available: 20 });

    const exported: string = await runE2eeCli(["export-public"], cliRuntime);
    expect(exported).toContain('"protocol": "murmur-e2ee-v1"');
    expect(exported).toContain('"root_public_key"');
    expect(exported).not.toContain(privateRoot);
    expect(exported).not.toContain("private_key");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("local E2E trust fails without a credential-derived active tenant", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-cli-unbound-"));
  const path: string = join(directory, "vault.sqlite");
  try {
    await expect(
      runE2eeCli(["trust", "--agent", PEER_ID, "--fingerprint", PEER_FINGERPRINT], runtime(path)),
    ).rejects.toThrow("No active E2E tenant is bound");
    expect(await runE2eeCli(["--help"], runtime(path))).toContain("export-public");
    await expect(runE2eeCli(["status", "--unknown", "value"], runtime(path))).rejects.toThrow(
      "Unknown E2E command option",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
