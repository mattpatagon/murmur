import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  encryptCanaryE2eeMessage,
} from "../scripts/lib/e2ee-canary-crypto.js";
import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../src/domain/contracts.js";
import type { TenantId } from "../src/domain/value-objects.js";
import type { PublicAgentKeyBundleDto } from "../src/e2ee/wire-contracts.js";
import type {
  AcknowledgeEncryptedMessagesOutput,
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
  E2eeCapabilityOutput,
  EncryptedInboxOutput,
  EncryptedMessageDto,
  EncryptedMessageReadReceiptDto,
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
import type { EffectiveOrchestratorDto } from "../src/hosted/orchestration-contracts.js";
import { callE2eeTool, type E2eeToolContext } from "../src/mcp/murmur-e2ee-tools.js";
import type {
  E2eeMessageStore,
  E2eeWriteAuthorization,
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
    unprovisionedActiveAgents: 0,
    unreadPlaintextMessages: 0,
  });
}
function capability(state: E2eeEntitlementRecord["state"]): E2eeCapabilityOutput {
  return {
    caller_authority: "peer",
    max_ciphertext_bytes: 524_304,
    max_one_time_prekeys: 20,
    protocol: "murmur-e2ee-v1",
    state,
    tenant_id: TENANT_ID,
    wire_version: 1,
  };
}
class FakeE2eeStore implements E2eeMessageStore {
  public claimAuthorization: E2eeWriteAuthorization | null = null;
  public claimInput: ClaimEncryptionPrekeyInput | null = null;
  public inboxes: EncryptedInboxOutput[] = [];
  public publishInput: PublishAgentKeyBundleInput | null = null;
  public putOutput: PutEncryptedMessageOutput | null = null;
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
  public claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
    authorization?: E2eeWriteAuthorization,
  ): ClaimEncryptionPrekeyOutput {
    this.claimAuthorization = authorization ?? null;
    this.claimInput = input;
    return {
      bundle: bundle(input.recipient_id),
      claim_id: "22222222-2222-4222-8222-222222222222",
      claimed_at: NOW,
      expires_at: "2026-08-10T17:05:00.000Z",
      prekey_class: "fallback",
      prekey_id: FALLBACK_PREKEY_ID,
      provenance:
        authorization === undefined
          ? {
              message_kind: "message",
              orchestrator_policy_id: null,
              sender_authority: "peer",
            }
          : authorization.provenance,
      recipient_id: input.recipient_id,
    };
  }
  public putEncryptedMessage(_input: PutEncryptedMessageInput): PutEncryptedMessageOutput {
    if (this.putOutput === null) throw new Error("fake message output is unavailable");
    return this.putOutput;
  }
  public getEncryptedMessages(input: GetEncryptedMessagesInput): EncryptedInboxOutput {
    const output: EncryptedInboxOutput | undefined = this.inboxes.shift();
    if (output !== undefined) return output;
    return { agent_id: input.agent_id, inbox_version: input.after_sequence, messages: [] };
  }
  public markEncryptedMessagesRead(input: MarkMessagesReadInput): MarkMessagesReadOutput {
    return { read_at: NOW, updated: input.message_ids.length };
  }
  public acknowledgeEncryptedMessages(
    input: MarkMessagesReadInput,
  ): AcknowledgeEncryptedMessagesOutput {
    return {
      receipts: input.message_ids.map(
        (message_id: string): EncryptedMessageReadReceiptDto => ({ message_id, read_at: NOW }),
      ),
      updated: input.message_ids.length,
    };
  }
  public prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
  ): PrepareEncryptedBroadcastOutput {
    return {
      broadcast_id: "44444444-4444-4444-8444-444444444444",
      claims: [],
      duplicate: false,
      expires_at: EXPIRES_AT,
      recipient_count: 0,
      thread_id: input.thread_id === undefined ? "fake-broadcast-thread" : input.thread_id,
    };
  }
  public putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
  ): PutEncryptedBroadcastDeliveryOutput {
    return {
      accepted: true,
      duplicate: false,
      recipient_id: input.envelope.header.recipient_id,
    };
  }
  public commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
  ): CommitEncryptedBroadcastOutput {
    return {
      broadcast_id: input.broadcast_id,
      committed_at: NOW,
      duplicate: false,
      recipient_count: 0,
      status: "stored",
    };
  }
  public cancelEncryptedBroadcast(
    _input: CancelEncryptedBroadcastInput,
  ): CancelEncryptedBroadcastOutput {
    return { cancelled: true };
  }

  public getEncryptedInboxSummary(input: GetInboxSummaryInput): GetInboxSummaryOutput {
    return {
      agent_id: input.agent_id,
      inbox_version: 1,
      newest_sequence: 1,
      unread_count: 1,
    };
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
  return {
    authorizeAgent: async (): Promise<void> => {},
    boundAgentId: null,
    capability: capability(state),
    entitlement: entitlement(state),
    orchestrationScope: null,
    resolveOrchestrator: null,
    senderAuthority: "peer",
    sleep,
    store,
  };
}

function structured(output: CallToolResult | null): Record<string, unknown> {
  if (output === null || output.structuredContent === undefined) {
    throw new Error("Encrypted tool result omitted structured content");
  }
  return output.structuredContent;
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

test("resolves encrypted orchestration claims entirely from authenticated server context", async (): Promise<void> => {
  const store: FakeE2eeStore = new FakeE2eeStore();
  const policyId: string = "33333333-3333-4333-8333-333333333333";
  const routedContext: E2eeToolContext = {
    ...context("enforced", store),
    resolveOrchestrator: async (): Promise<EffectiveOrchestratorDto> => ({
      agent_id: "orchestrator",
      policy_id: policyId,
      scope: { machine: null, personal_id: null, repository: null, scope_kind: "organization" },
    }),
  };
  const output: CallToolResult | null = await callE2eeTool(
    "claim_orchestrator_prekey",
    {
      context: { branch: "feature/e2e", client: "codex", repository: "owner/repository" },
      sender_id: "alice",
      session_key: "worker-session",
    },
    routedContext,
  );
  if (output === null) throw new Error("Orchestrator claim was not routed");
  expect(store.claimInput).toEqual({
    context: { branch: "feature/e2e", client: "codex", repository: "owner/repository" },
    recipient_id: "orchestrator",
    sender_id: "alice",
    session_key: "worker-session",
  });
  expect(store.claimAuthorization).toEqual({
    boundSenderId: null,
    orchestrationScope: null,
    provenance: {
      message_kind: "orchestration_request",
      orchestrator_policy_id: policyId,
      sender_authority: "peer",
    },
  });
  expect(output.structuredContent).toMatchObject({
    claim: { recipient_id: "orchestrator" },
    orchestrator: { agent_id: "orchestrator", policy_id: policyId },
  });
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

test("routes every enforced ciphertext mutation through bounded validated outputs", async (): Promise<void> => {
  const store: FakeE2eeStore = new FakeE2eeStore();
  const now: Date = new Date();
  const alice: CanaryE2eeIdentity = await createCanaryE2eeIdentity("alice", now);
  const bob: CanaryE2eeIdentity = await createCanaryE2eeIdentity("bob", now);
  const bobBundle: ReturnType<typeof canaryE2eeBundle> = canaryE2eeBundle(bob);
  const oneTime: ReturnType<typeof canaryE2eeBundle>["one_time_prekeys"][number] | undefined =
    bobBundle.one_time_prekeys[0];
  if (oneTime === undefined) throw new Error("Fake recipient prekey is missing");
  const claim: ClaimEncryptionPrekeyOutput = {
    bundle: bobBundle,
    claim_id: "55555555-5555-4555-8555-555555555555",
    claimed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    prekey_class: "one_time",
    prekey_id: oneTime.prekey_id,
    provenance: {
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    },
    recipient_id: "bob",
  };
  const put: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
    branch: "production-canary",
    claim,
    idempotencyKey: "mcp-enforced-complete",
    pairCounter: 1,
    plaintext: "ciphertext route coverage",
    recipient: bob,
    repository: "owner/repository",
    sender: alice,
    senderId: "alice",
    tenantId: TENANT_ID,
  });
  expect(put.envelope.header.branch_name).toBe("production-canary");
  const aliceBundle: ReturnType<typeof canaryE2eeBundle> = canaryE2eeBundle(alice);
  const message: EncryptedMessageDto = {
    envelope: put.envelope,
    read_at: null,
    sender_chain: {
      agent_certificate: aliceBundle.agent_certificate,
      root_key_id: aliceBundle.root_key_id,
      root_public_key: aliceBundle.root_public_key,
    },
    tenant_sequence: 1,
  };
  store.putOutput = { duplicate: false, message, retention_days: 30, status: "stored" };
  store.inboxes.push({ agent_id: "bob", inbox_version: 1, messages: [message] });
  const routed: E2eeToolContext = context("enforced", store);

  expect(structured(await callE2eeTool("put_encrypted_message", put, routed))).toMatchObject({
    duplicate: false,
  });
  expect(
    structured(
      await callE2eeTool(
        "get_encrypted_messages",
        { after_sequence: 0, agent_id: "bob", limit: 10, unread_only: false },
        routed,
      ),
    ),
  ).toMatchObject({ agent_id: "bob", inbox_version: 1 });
  expect(
    structured(
      await callE2eeTool(
        "acknowledge_encrypted_messages",
        { agent_id: "bob", message_ids: [put.envelope.header.message_id] },
        routed,
      ),
    ),
  ).toEqual({
    receipts: [{ message_id: put.envelope.header.message_id, read_at: NOW }],
    updated: 1,
  });
  expect(
    structured(
      await callE2eeTool(
        "prepare_encrypted_broadcast",
        {
          audience: {},
          context: { branch: "feature/e2e", client: "codex", repository: "owner/repository" },
          sender_id: "alice",
        },
        routed,
      ),
    ),
  ).toMatchObject({ recipient_count: 0 });
  expect(
    structured(
      await callE2eeTool(
        "put_encrypted_broadcast_delivery",
        {
          broadcast_id: "44444444-4444-4444-8444-444444444444",
          claim_id: claim.claim_id,
          envelope: put.envelope,
        },
        routed,
      ),
    ),
  ).toMatchObject({ accepted: true, recipient_id: "bob" });
  expect(
    structured(
      await callE2eeTool(
        "commit_encrypted_broadcast",
        { broadcast_id: "44444444-4444-4444-8444-444444444444" },
        routed,
      ),
    ),
  ).toMatchObject({ status: "stored" });
  expect(
    structured(
      await callE2eeTool(
        "cancel_encrypted_broadcast",
        { broadcast_id: "44444444-4444-4444-8444-444444444444" },
        routed,
      ),
    ),
  ).toEqual({ cancelled: true });
  expect(
    structured(await callE2eeTool("get_inbox_summary", { agent_id: "bob" }, routed)),
  ).toMatchObject({ agent_id: "bob", unread_count: 1 });
});
