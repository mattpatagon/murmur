import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock, Instant } from "../src/domain/value-objects.js";
import {
  AgentClient,
  BranchName,
  Instant as InstantValue,
  RepositoryName,
} from "../src/domain/value-objects.js";
import { trustPeerFingerprint } from "../src/e2ee/local-commands.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { StoredPrekey, StoredRootKey } from "../src/e2ee/local-vault-rows.js";
import type { ProxyInboxOutput, ProxySendMessageOutput } from "../src/e2ee/proxy-contracts.js";
import { E2eeProxyService } from "../src/e2ee/proxy-service.js";
import type { MarkMessagesReadOutput } from "../src/domain/contracts.js";
import { assertNoE2eePlaintextLeak, type LeakScanResult } from "../scripts/e2ee-leak-detector.js";
import { MemoryE2eeBackend, MemoryE2eeRemote } from "./support/e2ee-memory-remote.js";

const NOW_TEXT: string = "2026-08-10T20:00:00.000Z";
const TENANT_ID: string = "00000000-0000-4000-8000-000000000010";
const SENDER_ID: string = "machine-a:codex:repo-a:1";
const RECIPIENT_ID: string = "machine-b:codex:repo-b:2";
const SENTINEL: string = "murmur-e2ee-direct-7f0d58f1-0b9f-48f7-9ed8-🔐";

class FixedClock implements Clock {
  public now(): Instant {
    return InstantValue.parse(NOW_TEXT);
  }
}

function service(
  vault: LocalE2eeVault,
  remote: MemoryE2eeRemote,
  repository: string,
  branch: string,
): E2eeProxyService {
  return new E2eeProxyService({
    branchName: BranchName.parse(branch),
    client: AgentClient.parse("codex"),
    clock: new FixedClock(),
    remote,
    repositoryName: RepositoryName.parse(repository),
    trustOnFirstUse: false,
    vault,
  });
}

function root(vault: LocalE2eeVault): StoredRootKey {
  const stored: StoredRootKey | null = vault.keys.getRoot();
  if (stored === null) throw new Error("Expected a registered local root key");
  return stored;
}

function privateOneTimePrekeys(vault: LocalE2eeVault, agentId: string): number {
  return vault.keys
    .listPrekeys(agentId, "one_time")
    .filter((prekey: StoredPrekey): boolean => prekey.privateKey !== null).length;
}

test("two local proxies exchange, verify, decrypt, retry, and acknowledge without hosted plaintext", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-proxy-exchange-"));
  const senderVault: LocalE2eeVault = new LocalE2eeVault(
    join(directory, "machine-a-vault.sqlite"),
    "linux",
  );
  const recipientVault: LocalE2eeVault = new LocalE2eeVault(
    join(directory, "machine-b-vault.sqlite"),
    "linux",
  );
  const backend: MemoryE2eeBackend = new MemoryE2eeBackend();
  const sender: E2eeProxyService = service(
    senderVault,
    new MemoryE2eeRemote(backend),
    "example/repo-a",
    "feature/sender",
  );
  const recipient: E2eeProxyService = service(
    recipientVault,
    new MemoryE2eeRemote(backend),
    "example/repo-b",
    "feature/recipient",
  );
  try {
    await sender.registerAgent({ agent_id: SENDER_ID, display_name: "Sender" });
    await recipient.registerAgent({ agent_id: RECIPIENT_ID, display_name: "Recipient" });
    const senderRoot: StoredRootKey = root(senderVault);
    const recipientRoot: StoredRootKey = root(recipientVault);
    trustPeerFingerprint(
      senderVault,
      { agentId: RECIPIENT_ID, rootKeyId: recipientRoot.rootKeyId, tenantId: TENANT_ID },
      InstantValue.parse(NOW_TEXT),
    );
    trustPeerFingerprint(
      recipientVault,
      { agentId: SENDER_ID, rootKeyId: senderRoot.rootKeyId, tenantId: TENANT_ID },
      InstantValue.parse(NOW_TEXT),
    );

    const sent: ProxySendMessageOutput = await sender.sendMessage({
      content: SENTINEL,
      idempotency_key: "direct-cross-machine-1",
      recipient_id: RECIPIENT_ID,
      sender_id: SENDER_ID,
    });
    expect(sent.duplicate).toBe(false);
    expect(sent.message).toMatchObject({
      content: SENTINEL,
      context: {
        branch: "feature/sender",
        client: "codex",
        repository: "example/repo-a",
      },
      encryption: {
        context_binding: "verified",
        recipient_prekey_class: "one_time",
        verification_mode: "strict",
      },
      recipient_id: RECIPIENT_ID,
      sender_id: SENDER_ID,
    });
    const retried: ProxySendMessageOutput = await sender.sendMessage({
      content: SENTINEL,
      idempotency_key: "direct-cross-machine-1",
      recipient_id: RECIPIENT_ID,
      sender_id: SENDER_ID,
    });
    expect(retried.duplicate).toBe(true);
    expect(retried.message.message_id).toBe(sent.message.message_id);

    expect(privateOneTimePrekeys(recipientVault, RECIPIENT_ID)).toBe(20);
    const inbox: ProxyInboxOutput = await recipient.getMessages({
      after_sequence: 0,
      agent_id: RECIPIENT_ID,
      limit: 100,
      unread_only: false,
    });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toEqual(sent.message);
    expect(privateOneTimePrekeys(recipientVault, RECIPIENT_ID)).toBe(19);

    const marked: MarkMessagesReadOutput = await recipient.markMessagesRead({
      agent_id: RECIPIENT_ID,
      message_ids: [sent.message.message_id],
    });
    expect(marked.updated).toBe(1);
    const unread: ProxyInboxOutput = await recipient.getMessages({
      after_sequence: 0,
      agent_id: RECIPIENT_ID,
      limit: 100,
      unread_only: true,
    });
    expect(unread.messages).toEqual([]);

    const captures: string = JSON.stringify(backend.captures, null, 2);
    expect(captures).not.toContain(SENTINEL);
    expect(captures).not.toContain(Buffer.from(senderRoot.privateKey).toString("base64url"));
    const captureDirectory: string = join(directory, "hosted-captures");
    const capturePath: string = join(captureDirectory, "wire.json");
    mkdirSync(captureDirectory, { recursive: true });
    writeFileSync(capturePath, captures);
    const scan: LeakScanResult = assertNoE2eePlaintextLeak(captureDirectory, [SENTINEL]);
    expect(scan.findings).toEqual([]);
    expect(
      backend.captures.some(
        (capture: (typeof backend.captures)[number]): boolean =>
          capture.tool === "put_encrypted_message",
      ),
    ).toBe(true);
  } finally {
    await Promise.allSettled([sender.close(), recipient.close()]);
    rmSync(directory, { force: true, recursive: true });
  }
});
