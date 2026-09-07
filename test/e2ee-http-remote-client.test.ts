import { expect, test } from "bun:test";
import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  encryptCanaryE2eeMessage,
} from "../scripts/lib/e2ee-canary-crypto.js";
import type {
  AgentDto,
  CloseAgentOutput,
  EndSessionOutput,
  RegisterAgentOutput,
} from "../src/domain/contracts.js";
import type { SubmitFeedbackOutput } from "../src/domain/feedback-contracts.js";
import { E2eeHttpRemoteClient, type E2eeWireToolCaller } from "../src/e2ee/http-remote-client.js";
import {
  ENCRYPTION_CLAIM_EXPIRED_MESSAGE,
  EncryptionClaimExpiredError,
} from "../src/e2ee/remote-client.js";
import type {
  ClaimEncryptionPrekeyOutput,
  E2eeCapabilityOutput,
  EncryptedMessageDto,
  PutEncryptedMessageInput,
  WaitForEncryptedMessagesOutput,
} from "../src/e2ee/wire-tools.js";
import type { EffectiveOrchestratorDto } from "../src/hosted/orchestration-contracts.js";

const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const CAPABILITY: E2eeCapabilityOutput = {
  caller_authority: "peer",
  max_ciphertext_bytes: 524_304,
  max_one_time_prekeys: 20,
  protocol: "murmur-e2ee-v1",
  state: "enforced",
  tenant_id: TENANT_ID,
  wire_version: 1,
};

type RecordedCall = {
  readonly input: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly timeoutMs: number;
};

class FakeCaller implements E2eeWireToolCaller {
  public readonly calls: RecordedCall[] = [];
  public closeError: unknown = null;
  public closeCount: number = 0;
  public response: unknown;
  public thrown: unknown = null;

  public constructor(response: unknown) {
    this.response = response;
  }

  public async call(
    name: string,
    input: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<unknown> {
    this.calls.push({ input, name, timeoutMs });
    if (this.thrown !== null) throw this.thrown;
    return this.response;
  }

  public async close(): Promise<void> {
    if (this.closeError !== null) throw this.closeError;
    this.closeCount += 1;
  }
}

function toolOutput(output: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ text: JSON.stringify(output), type: "text" }],
    structuredContent: output,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ text: JSON.stringify({ error: message }, null, 2), type: "text" }],
    isError: true,
  };
}

test("validates remote outputs and applies absolute request deadlines", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolOutput(CAPABILITY));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  expect(await client.capability()).toEqual(CAPABILITY);
  expect(caller.calls).toEqual([{ input: {}, name: "get_e2ee_capability", timeoutMs: 30_000 }]);

  const feedbackOutput: SubmitFeedbackOutput = {
    duplicate: false,
    status: "stored",
    submission: {
      context: { branch: "main", client: "codex", repository: "owner/repository" },
      created_at: "2026-08-20T12:00:00.000Z",
      description: "Forward plaintext feedback deliberately.",
      reporter_generation: 1,
      reporter_id: "alice",
      submission_id: "00000000-0000-4000-8000-000000000010",
      title: "Proxy feedback",
      type: "issue",
    },
  };
  caller.response = toolOutput(feedbackOutput);
  expect(
    await client.submitFeedback({
      description: "Forward plaintext feedback deliberately.",
      reporter_id: "alice",
      title: "Proxy feedback",
      type: "issue",
    }),
  ).toEqual(feedbackOutput);
  expect(caller.calls[1]).toEqual({
    input: {
      description: "Forward plaintext feedback deliberately.",
      reporter_id: "alice",
      title: "Proxy feedback",
      type: "issue",
    },
    name: "submit_feedback",
    timeoutMs: 30_000,
  });

  const waitOutput: WaitForEncryptedMessagesOutput = {
    agent_id: "alice",
    messages: [],
    timed_out: true,
  };
  caller.response = toolOutput(waitOutput);
  expect(
    await client.waitForEncryptedMessages({
      after_sequence: 12,
      agent_id: "alice",
      timeout_seconds: 7,
    }),
  ).toEqual(waitOutput);
  expect(caller.calls[2]).toEqual({
    input: { after_sequence: 12, agent_id: "alice", timeout_seconds: 7 },
    name: "wait_for_encrypted_messages",
    timeoutMs: 12_000,
  });
});

test("forwards metadata-only agent lifecycle operations through the encrypted endpoint", async (): Promise<void> => {
  const agent: AgentDto = {
    agent_id: "alice",
    authority: "peer",
    closed_at: null,
    close_reason: null,
    created_at: "2026-08-10T20:00:00.000Z",
    display_name: "Alice",
    generation: 2,
    last_seen_at: "2026-08-10T20:00:00.000Z",
    lease_expires_at: "2026-08-10T20:15:00.000Z",
    live_session_count: 1,
    metadata: {},
    state: "active",
  };
  const caller: FakeCaller = new FakeCaller(toolOutput({ agent }));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  expect(await client.getAgent({ agent_id: "alice" })).toEqual({ agent });
  const ended: EndSessionOutput = { ended: 1, generation: 2 };
  caller.response = toolOutput(ended);
  expect(
    await client.endSession({
      agent_id: "alice",
      end_default_session: true,
      expected_generation: 2,
      reason: "stop",
      session_key: "pane-1",
    }),
  ).toEqual(ended);
  const closed: CloseAgentOutput = {
    agent: {
      ...agent,
      close_reason: "completed",
      closed_at: "2026-08-10T20:01:00.000Z",
      lease_expires_at: null,
      live_session_count: 0,
      state: "closed",
    },
    already_closed: false,
    ended_sessions: 0,
    unread_count: 0,
  };
  caller.response = toolOutput(closed);
  expect(
    await client.closeAgent({
      agent_id: "alice",
      expected_generation: 2,
      reason: "completed",
    }),
  ).toEqual(closed);
  expect(caller.calls.map((call: RecordedCall): string => call.name)).toEqual([
    "get_agent",
    "end_session",
    "close_agent",
  ]);
});

test("forwards every bounded encrypted and orchestration operation", async (): Promise<void> => {
  const now: Date = new Date();
  const alice: CanaryE2eeIdentity = await createCanaryE2eeIdentity("alice", now);
  const bob: CanaryE2eeIdentity = await createCanaryE2eeIdentity("bob", now);
  const aliceBundle: ReturnType<typeof canaryE2eeBundle> = canaryE2eeBundle(alice);
  const bobBundle: ReturnType<typeof canaryE2eeBundle> = canaryE2eeBundle(bob);
  const bobOneTime: ReturnType<typeof canaryE2eeBundle>["one_time_prekeys"][number] | undefined =
    bobBundle.one_time_prekeys[0];
  if (bobOneTime === undefined) throw new Error("Canary recipient prekey is missing");
  const claim: ClaimEncryptionPrekeyOutput = {
    bundle: bobBundle,
    claim_id: "22222222-2222-4222-8222-222222222222",
    claimed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    prekey_class: "one_time",
    prekey_id: bobOneTime.prekey_id,
    provenance: {
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    },
    recipient_id: "bob",
  };
  const encryptedInput: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
    branch: "feature/hosted-e2ee",
    claim,
    idempotencyKey: "http-remote-complete",
    pairCounter: 1,
    plaintext: "encrypted wrapper coverage",
    recipient: bob,
    repository: "mattpatagon/murmur",
    sender: alice,
    senderId: "alice",
    tenantId: TENANT_ID,
  });
  const encryptedMessage: EncryptedMessageDto = {
    envelope: encryptedInput.envelope,
    read_at: null,
    sender_chain: {
      agent_certificate: aliceBundle.agent_certificate,
      root_key_id: aliceBundle.root_key_id,
      root_public_key: aliceBundle.root_public_key,
    },
    tenant_sequence: 1,
  };
  const orchestrator: EffectiveOrchestratorDto = {
    agent_id: "bob",
    policy_id: "33333333-3333-4333-8333-333333333333",
    scope: {
      machine: null,
      personal_id: null,
      repository: "mattpatagon/murmur",
      scope_kind: "organization",
    },
  };
  const agent: AgentDto = {
    agent_id: "alice",
    authority: "peer",
    closed_at: null,
    close_reason: null,
    created_at: now.toISOString(),
    display_name: "Alice",
    generation: 1,
    last_seen_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
    live_session_count: 1,
    metadata: {},
    state: "active",
  };
  const registered: RegisterAgentOutput = {
    agent,
    inbox_uri: "murmur://inbox/alice",
    lease_minutes: 60,
    reopened: false,
    repository_diverged: false,
    retention_days: 30,
  };
  const caller: FakeCaller = new FakeCaller(toolOutput(registered));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  expect(await client.registerAgent({ agent_id: "alice" })).toEqual(registered);

  caller.response = toolOutput({ agents: [agent], next_cursor: null });
  expect((await client.listAgents({ limit: 10, state: "all" })).agents).toEqual([agent]);
  caller.response = toolOutput({
    agent_id: "alice",
    fallback_prekey_id: aliceBundle.fallback_prekey.prekey_id,
    one_time_prekey_count: 1,
    published_at: now.toISOString(),
    root_key_id: aliceBundle.root_key_id,
  });
  await client.publishAgentKeyBundle({ agent_id: "alice", bundle: aliceBundle });

  caller.response = toolOutput(claim);
  expect(
    await client.claimEncryptionPrekey({
      context: {
        branch: "feature/e2ee",
        client: "codex",
        repository: "mattpatagon/murmur",
      },
      recipient_id: "bob",
      sender_id: "alice",
    }),
  ).toEqual(claim);
  caller.response = toolOutput({ caller_authority: "peer", orchestrator });
  expect(await client.getOrchestrator({})).toEqual({ caller_authority: "peer", orchestrator });
  caller.response = toolOutput({
    policy: {
      ...orchestrator,
      created_at: now.toISOString(),
      created_by_token_id: "44444444-4444-4444-8444-444444444444",
      enabled: true,
      instructions: "Handle bounded production coordination",
      orchestrator_token_id: "55555555-5555-4555-8555-555555555555",
      updated_at: now.toISOString(),
      updated_by_token_id: "44444444-4444-4444-8444-444444444444",
    },
  });
  expect((await client.getDelegation({ policy_id: orchestrator.policy_id })).policy.policy_id).toBe(
    orchestrator.policy_id,
  );

  const orchestratorClaim: ClaimEncryptionPrekeyOutput = {
    ...claim,
    provenance: {
      message_kind: "orchestration_request",
      orchestrator_policy_id: orchestrator.policy_id,
      sender_authority: "peer",
    },
  };
  caller.response = toolOutput({ claim: orchestratorClaim, orchestrator });
  expect(
    (
      await client.claimOrchestratorPrekey({
        context: {
          branch: "feature/e2ee",
          client: "codex",
          repository: "mattpatagon/murmur",
        },
        sender_id: "alice",
      })
    ).orchestrator,
  ).toEqual(orchestrator);

  caller.response = toolOutput({
    duplicate: false,
    message: encryptedMessage,
    retention_days: 30,
    status: "stored",
  });
  expect((await client.putEncryptedMessage(encryptedInput)).message).toEqual(encryptedMessage);
  caller.response = toolOutput({ agent_id: "bob", inbox_version: 1, messages: [encryptedMessage] });
  expect(
    (
      await client.getEncryptedMessages({
        after_sequence: 0,
        agent_id: "bob",
        limit: 10,
        unread_only: false,
      })
    ).messages,
  ).toEqual([encryptedMessage]);
  caller.response = toolOutput({ read_at: now.toISOString(), updated: 1 });
  expect(
    await client.markMessagesRead({
      agent_id: "bob",
      message_ids: [encryptedInput.envelope.header.message_id],
    }),
  ).toEqual({ read_at: now.toISOString(), updated: 1 });
  caller.response = toolOutput({
    receipts: [
      {
        message_id: encryptedInput.envelope.header.message_id,
        read_at: now.toISOString(),
      },
    ],
    updated: 1,
  });
  expect(
    await client.acknowledgeMessages({
      agent_id: "bob",
      message_ids: [encryptedInput.envelope.header.message_id],
    }),
  ).toEqual({
    receipts: [
      { message_id: encryptedInput.envelope.header.message_id, read_at: now.toISOString() },
    ],
    updated: 1,
  });
  const acknowledgementCall: RecordedCall | undefined = caller.calls.at(-1);
  if (acknowledgementCall === undefined) throw new Error("Missing acknowledgement call");
  expect(acknowledgementCall.name).toBe("acknowledge_encrypted_messages");

  caller.response = toolOutput({
    broadcast_id: "66666666-6666-4666-8666-666666666666",
    claims: [],
    duplicate: false,
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    recipient_count: 0,
    thread_id: "bounded-broadcast",
  });
  await client.prepareEncryptedBroadcast({
    audience: {},
    context: {
      branch: "feature/e2ee",
      client: "codex",
      repository: "mattpatagon/murmur",
    },
    sender_id: "alice",
  });
  await expect(
    client.putEncryptedBroadcastDelivery({
      broadcast_id: "66666666-6666-4666-8666-666666666666",
      claim_id: claim.claim_id,
      envelope: encryptedInput.envelope,
    }),
  ).rejects.toThrow();
  caller.response = toolOutput({
    broadcast_id: "66666666-6666-4666-8666-666666666666",
    committed_at: now.toISOString(),
    duplicate: false,
    recipient_count: 0,
    status: "stored",
  });
  await client.commitEncryptedBroadcast({
    broadcast_id: "66666666-6666-4666-8666-666666666666",
  });
  caller.response = toolOutput({ cancelled: true });
  await client.cancelEncryptedBroadcast({
    broadcast_id: "66666666-6666-4666-8666-666666666666",
  });
  caller.response = toolOutput({
    agent_id: "bob",
    inbox_version: 1,
    newest_sequence: 1,
    unread_count: 1,
  });
  expect((await client.getInboxSummary({ agent_id: "bob" })).unread_count).toBe(1);
});

test("translates untrusted failures without exposing upstream details", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller({ malformed: "secret-body" });
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await expect(client.capability()).rejects.toThrow(
    "The encrypted Murmur service returned an invalid response",
  );

  caller.response = toolError("database URL postgres://secret");
  await expect(client.capability()).rejects.toThrow(
    "The encrypted Murmur service rejected the request",
  );

  caller.thrown = new Error("Authorization: Bearer secret-token");
  await expect(client.capability()).rejects.toThrow("The encrypted Murmur service request failed");
});

test("recognizes only the exact safe prekey-expiry response", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolError(ENCRYPTION_CLAIM_EXPIRED_MESSAGE));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await expect(client.capability()).rejects.toBeInstanceOf(EncryptionClaimExpiredError);

  caller.response = toolError(`${ENCRYPTION_CLAIM_EXPIRED_MESSAGE}.`);
  await expect(client.capability()).rejects.toThrow(
    "The encrypted Murmur service rejected the request",
  );
});

test("closes idempotently and rejects calls after shutdown", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolOutput(CAPABILITY));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await client.close();
  await client.close();
  expect(caller.closeCount).toBe(1);
  await expect(client.capability()).rejects.toThrow("remote client is closed");
});

test("normalizes remote shutdown failure", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolOutput(CAPABILITY));
  caller.closeError = new Error("sensitive close detail");
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await expect(client.close()).rejects.toThrow("encrypted Murmur service shutdown failed");
});
