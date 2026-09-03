import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import { retireConfiguredLocalAgentKey } from "../src/e2ee/local-vault-retirement.js";

test("retirement skips a missing default vault without creating it", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-retirement-missing-"));
  try {
    expect((): void =>
      retireConfiguredLocalAgentKey("missing-agent", "2026-01-01T00:00:00.000Z", {
        XDG_DATA_HOME: directory,
      }),
    ).not.toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("retirement closes a configured vault and starts the retention window", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-vault-retirement-"));
  const path: string = join(directory, "custom vault.sqlite");
  const agentId: string = "completed-session-agent";
  const created: LocalE2eeVault = new LocalE2eeVault(path, process.platform);
  try {
    await created.keys.getOrCreateAgent(
      agentId,
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    );
  } finally {
    created.close();
  }

  retireConfiguredLocalAgentKey(agentId, "2026-01-02T00:00:00.000Z", {}, path);

  const reopened: LocalE2eeVault = new LocalE2eeVault(path, process.platform);
  try {
    reopened.purgeExpired("2026-02-01T00:00:00.000Z");
    expect(reopened.keys.getAgent(agentId)).toBeNull();
  } finally {
    reopened.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
