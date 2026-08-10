import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../src/domain/contracts.js";
import type { TenantId } from "../src/domain/value-objects.js";
import type { PublicAgentKeyBundleDto } from "../src/e2ee/wire-contracts.js";
import type {
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
  E2eeCapabilityOutput,
  EncryptedInboxOutput,
  GetEncryptedMessagesInput,
  GetInboxSummaryInput,
  GetInboxSummaryOutput,
  PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastOutput,
  PublishAgentKeyBundleInput,
  PublishAgentKeyBundleOutput,
  PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedMessageInput,
  PutEncryptedMessageOutput,
} from "../src/e2ee/wire-tools.js";
import {
  type E2eeEntitlementRecord,
  parseE2eeEntitlementRecord,
} from "../src/hosted/e2ee-entitlement.js";
import { callE2eeTool, type E2eeToolContext } from "../src/mcp/murmur-e2ee-tools.js";
import type {
  E2eeMessageStore,
  EncryptedInboxUpdateHandler,
} from "../src/storage/e2ee-message-store.js";
import type { InboxSubscription } from "../src/storage/message-store.js";

const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const NOW: string = "2026-08-10T17:00:00.000Z";
const EXPIRES_AT: string = "2026-09-09T17:00:00.000Z";
const ROOT_KEY_ID: string = `mrk_${"A".repeat(43)}`;
const AGENT_KEY_ID: string = `mak_${"B".repeat(43)}`;
const FALLBACK_PREKEY_ID: string = `mpk_${"C".repeat(43)}`;

function bundle(agentId: string): PublicAgentKeyBundleDto {
  return {
    agent_certificate: {
      agent_id: agentId,
      created_at: NOW,
      expires_at: EXPIRES_AT,
      root_key_id: ROOT_KEY_ID,
      signature: "D".repeat(86),
      signing_key_id: AGENT_KEY_ID,
      signing_public_key: "E".repeat(43),
    },
    fallback_prekey: {
      agent_id: agentId,
      agent_signing_key_id: AGENT_KEY_ID,
      created_at: NOW,
      expires_at: EXPIRES_AT,
      prekey_class: "fallback",
      prekey_id: FALLBACK_PREKEY_ID,
      prekey_public_key: "F".repeat(43),
      signature: "G".repeat(86),
    },
    one_time_prekeys: [],
    root_key_id: ROOT_KEY_ID,
    root_public_key: "H".repeat(43),
  };
}

function entitlement(state: E2eeEntitlementRecord["state"]): E2eeEntitlementRecord {
  return parseE2eeEntitlementRecord({
    plaintextWritesBlocked: state === "enforced",
    retainedCiphertextMessages: 0,
    state,
    trustPolicyVersion: state === "enforced" ? 1 : null,
    unreadPlaintextMessages: 0,
  });
}

function capability(state: E2eeEntitlementRecord["state"]): E2eeCapabilityOutput {
  return {
    max_ciphertext_bytes: 524_304,
    max_one_time_prekeys: 20,
    protocol: "murmur-e2ee-v1",
    state,
    tenant_id: TENANT_ID,
    wire_version: 1,
  };
}

class FakeE2eeStore implements E2eeMessageStore {
  public inboxes: EncryptedInboxOutput[] = [];
  public publishInput: PublishAgentKeyBundleInput | null = null;
  public watchCloseCount: number = 0;

  public scopeE2ee(_tenantId: TenantId): E2eeMessageStore {
    return this;
  }

  public publishAgentKeyBundle(input: PublishAgentKeyBundleInput): PublishAgentKeyBundleOutput {
    this.publishInput = input;
    return {
      agent_id: input.agent_id,
      fallback_prekey_id: input.bundle.fallback_prekey.prekey_id,
      one_time_prekey_count: input.bundle.one_time_prekeys.length,
      published_at: NOW,
      root_key_id: input.bundle.root_key_id,
    };
  }

  public claimEncryptionPrekey(_input: ClaimEncryptionPrekeyInput): ClaimEncryptionPrekeyOutput {
    throw new Error("unused fake claim");
  }

  public putEncryptedMessage(_input: PutEncryptedMessageInput): PutEncryptedMessageOutput {
    throw new Error("unused fake message put");
  }

  public getEncryptedMessages(input: GetEncryptedMessagesInput): EncryptedInboxOutput {
    const output: EncryptedInboxOutput | undefined = this.inboxes.shift();
    if (output !== undefined) return output;
    return { agent_id: input.agent_id, inbox_version: input.after_sequence, messages: [] };
  }

  public markEncryptedMessagesRead(_input: MarkMessagesReadInput): MarkMessagesReadOutput {
    return { read_at: NOW, updated: 1 };
  }

  public prepareEncryptedBroadcast(
    _input: PrepareEncryptedBroadcastInput,
  ): PrepareEncryptedBroadcastOutput {
    throw new Error("unused fake broadcast prepare");
  }

  public putEncryptedBroadcastDelivery(
    _input: PutEncryptedBroadcastDeliveryInput,
  ): PutEncryptedBroadcastDeliveryOutput {
    throw new Error("unused fake broadcast delivery");
  }

  public commitEncryptedBroadcast(
    _input: CommitEncryptedBroadcastInput,
  ): CommitEncryptedBroadcastOutput {
    throw new Error("unused fake broadcast commit");
  }

  public cancelEncryptedBroadcast(
    _input: CancelEncryptedBroadcastInput,
  ): CancelEncryptedBroadcastOutput {
    throw new Error("unused fake broadcast cancel");
  }

  public getEncryptedInboxSummary(_input: GetInboxSummaryInput): GetInboxSummaryOutput {
    throw new Error("unused fake inbox summary");
  }

  public async watchEncryptedInbox(
    _agentId: string,
    _afterSequence: number,
    _handler: EncryptedInboxUpdateHandler,
  ): Promise<InboxSubscription> {
    return {
      close: (): void => {
        this.watchCloseCount += 1;
      },
    };
  }

  public close(): void {}
}

function context(
  state: E2eeEntitlementRecord["state"],
  store: E2eeMessageStore | null,
  sleep: (milliseconds: number) => Promise<void> = async (): Promise<void> => {},
): E2eeToolContext {
  return { capability: capability(state), entitlement: entitlement(state), sleep, store };
}

test("returns only the server-derived capability in the off state", async (): Promise<void> => {
  const store: FakeE2eeStore = new FakeE2eeStore();
  const output: CallToolResult | null = await callE2eeTool(
    "get_e2ee_capability",
    {},
    context("off", store),
  );
  if (output === null) throw new Error("Capability call was not routed");
  expect(output.structuredContent).toEqual(capability("off"));
  expect(await callE2eeTool("publish_agent_key_bundle", {}, context("off", store))).toBeNull();
  expect(await callE2eeTool("put_encrypted_message", {}, context("off", store))).toBeNull();
  await expect(
    callE2eeTool(
      "get_e2ee_capability",
      {},
      {
        ...context("off", store),
        capability: capability("enforced"),
      },
    ),
  ).rejects.toThrow("state is inconsistent");
});

test("validates and delegates public bundle provisioning without accepting secrets", async (): Promise<void> => {
  const store: FakeE2eeStore = new FakeE2eeStore();
  const input: PublishAgentKeyBundleInput = { agent_id: "alice", bundle: bundle("alice") };
  const output: CallToolResult | null = await callE2eeTool(
    "publish_agent_key_bundle",
    input,
    context("provisioning", store),
  );
  if (output === null) throw new Error("Bundle publication was not routed");
  expect(store.publishInput).toEqual(input);
  expect(output.structuredContent).toMatchObject({ agent_id: "alice", one_time_prekey_count: 0 });
  await expect(
    callE2eeTool(
      "publish_agent_key_bundle",
      { ...input, private_key: "forbidden" },
      context("provisioning", store),
    ),
  ).rejects.toThrow();
  expect(
    await callE2eeTool(
      "mark_messages_read",
      { agent_id: "alice", message_ids: ["22222222-2222-4222-8222-222222222222"] },
      context("provisioning", store),
    ),
  ).toBeNull();
});

test("bounds encrypted waits and always closes their subscription", async (): Promise<void> => {
  const store: FakeE2eeStore = new FakeE2eeStore();
  store.inboxes.push(
    { agent_id: "alice", inbox_version: 4, messages: [] },
    { agent_id: "alice", inbox_version: 4, messages: [] },
  );
  const sleepDurations: number[] = [];
  const output: CallToolResult | null = await callE2eeTool(
    "wait_for_encrypted_messages",
    { after_sequence: 4, agent_id: "alice", timeout_seconds: 7 },
    context("enforced", store, async (milliseconds: number): Promise<void> => {
      sleepDurations.push(milliseconds);
    }),
  );
  if (output === null) throw new Error("Encrypted wait was not routed");
  expect(output.structuredContent).toEqual({ agent_id: "alice", messages: [], timed_out: true });
  expect(sleepDurations).toEqual([7_000]);
  expect(store.watchCloseCount).toBe(1);
});

test("rejects a store response that crosses encrypted inbox identity", async (): Promise<void> => {
  const store: FakeE2eeStore = new FakeE2eeStore();
  store.inboxes.push({ agent_id: "mallory", inbox_version: 0, messages: [] });
  await expect(
    callE2eeTool(
      "get_encrypted_messages",
      { after_sequence: 0, agent_id: "alice", limit: 100, unread_only: false },
      context("enforced", store),
    ),
  ).rejects.toThrow("identity is inconsistent");
});
