import type {
  AgentDto,
  CloseAgentInput,
  CloseAgentOutput,
  EndSessionInput,
  EndSessionOutput,
  GetAgentInput,
  GetAgentOutput,
  ListAgentsInput,
  ListAgentsOutput,
  MarkMessagesReadInput,
  MarkMessagesReadOutput,
  RegisterAgentInput,
  RegisterAgentOutput,
} from "../../src/domain/contracts.js";
import { verifyHostedEncryptedEnvelope } from "../../src/e2ee/hosted-validation.js";
import type { E2eeProxyRemoteClient } from "../../src/e2ee/remote-client.js";
import type {
  PublicAgentKeyBundleDto,
  PublicAgentSigningChainDto,
} from "../../src/e2ee/wire-contracts.js";
import type {
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
  E2eeCapabilityOutput,
  EncryptedInboxOutput,
  EncryptedMessageDto,
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
  WaitForEncryptedMessagesInput,
  WaitForEncryptedMessagesOutput,
} from "../../src/e2ee/wire-tools.js";

const TENANT_ID: string = "00000000-0000-4000-8000-000000000010";
const NOW: string = "2026-08-10T20:00:00.000Z";

export type CapturedRemoteCall = {
  readonly input: unknown;
  readonly tool: string;
};

type StoredClaim = {
  readonly input: ClaimEncryptionPrekeyInput;
  readonly output: ClaimEncryptionPrekeyOutput;
};

function signingChain(bundle: PublicAgentKeyBundleDto): PublicAgentSigningChainDto {
  return {
    agent_certificate: bundle.agent_certificate,
    root_key_id: bundle.root_key_id,
    root_public_key: bundle.root_public_key,
  };
}

function agent(input: RegisterAgentInput): AgentDto {
  return {
    agent_id: input.agent_id,
    authority: "peer",
    closed_at: null,
    close_reason: null,
    created_at: NOW,
    display_name: input.display_name === undefined ? input.agent_id : input.display_name,
    generation: 1,
    last_seen_at: NOW,
    lease_expires_at: "2026-08-10T20:15:00.000Z",
    live_session_count: 1,
    metadata: input.metadata === undefined ? {} : input.metadata,
    state: "active",
  };
}

export class MemoryE2eeBackend {
  readonly #agents: Map<string, AgentDto> = new Map<string, AgentDto>();
  readonly #bundles: Map<string, PublicAgentKeyBundleDto> = new Map<
    string,
    PublicAgentKeyBundleDto
  >();
  readonly #claims: Map<string, StoredClaim> = new Map<string, StoredClaim>();
  readonly #claimedPrekeys: Set<string> = new Set<string>();
  readonly #messages: EncryptedMessageDto[] = [];
  readonly #idempotentMessages: Map<string, EncryptedMessageDto> = new Map<
    string,
    EncryptedMessageDto
  >();
  public readonly captures: CapturedRemoteCall[] = [];
  #claimCounter: number = 1;
  #sequence: number = 0;

  public capability(): E2eeCapabilityOutput {
    return {
      max_ciphertext_bytes: 524_304,
      max_one_time_prekeys: 100,
      protocol: "murmur-e2ee-v1",
      state: "enforced",
      tenant_id: TENANT_ID,
      wire_version: 1,
    };
  }

  public register(input: RegisterAgentInput): RegisterAgentOutput {
    const existing: AgentDto | undefined = this.#agents.get(input.agent_id);
    const stored: AgentDto =
      existing === undefined ? agent(input) : { ...agent(input), created_at: existing.created_at };
    this.#agents.set(input.agent_id, stored);
    return {
      agent: stored,
      inbox_uri: `murmur://inbox/${encodeURIComponent(input.agent_id)}`,
      lease_minutes: 15,
      reopened: false,
      repository_diverged: false,
      retention_days: 30,
    };
  }

  public list(): ListAgentsOutput {
    return {
      agents: Array.from(this.#agents.values()).sort((left: AgentDto, right: AgentDto): number =>
        left.agent_id.localeCompare(right.agent_id),
      ),
      next_cursor: null,
    };
  }

  public get(input: GetAgentInput): GetAgentOutput {
    const stored: AgentDto | undefined = this.#agents.get(input.agent_id);
    if (stored === undefined) throw new Error("agent missing");
    return { agent: stored };
  }

  public end(input: EndSessionInput): EndSessionOutput {
    const stored: AgentDto | undefined = this.#agents.get(input.agent_id);
    if (stored === undefined || stored.generation !== input.expected_generation) {
      throw new Error("agent generation mismatch");
    }
    const ended: number = stored.live_session_count === 0 ? 0 : 1;
    this.#agents.set(input.agent_id, {
      ...stored,
      lease_expires_at: null,
      live_session_count: 0,
      state: "inactive",
    });
    return { ended, generation: stored.generation };
  }

  public closeAgent(input: CloseAgentInput): CloseAgentOutput {
    const stored: AgentDto | undefined = this.#agents.get(input.agent_id);
    if (stored === undefined || stored.generation !== input.expected_generation) {
      throw new Error("agent generation mismatch");
    }
    const alreadyClosed: boolean = stored.state === "closed";
    const closed: AgentDto = {
      ...stored,
      close_reason: input.reason,
      closed_at: NOW,
      lease_expires_at: null,
      live_session_count: 0,
      state: "closed",
    };
    this.#agents.set(input.agent_id, closed);
    return {
      agent: closed,
      already_closed: alreadyClosed,
      ended_sessions: alreadyClosed ? 0 : stored.live_session_count,
      unread_count: this.#messages.filter(
        (message: EncryptedMessageDto): boolean =>
          message.envelope.header.recipient_id === input.agent_id && message.read_at === null,
      ).length,
    };
  }

  public publish(input: PublishAgentKeyBundleInput): PublishAgentKeyBundleOutput {
    this.#bundles.set(input.agent_id, structuredClone(input.bundle));
    return {
      agent_id: input.agent_id,
      fallback_prekey_id: input.bundle.fallback_prekey.prekey_id,
      one_time_prekey_count: input.bundle.one_time_prekeys.length,
      published_at: NOW,
      root_key_id: input.bundle.root_key_id,
    };
  }

  #claimId(): string {
    const suffix: string = this.#claimCounter.toString().padStart(12, "0");
    this.#claimCounter += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  }

  public claim(input: ClaimEncryptionPrekeyInput): ClaimEncryptionPrekeyOutput {
    const bundle: PublicAgentKeyBundleDto | undefined = this.#bundles.get(input.recipient_id);
    if (bundle === undefined) throw new Error("recipient bundle missing");
    const oneTime: PublicAgentKeyBundleDto["one_time_prekeys"][number] | undefined =
      bundle.one_time_prekeys.find(
        (prekey: PublicAgentKeyBundleDto["one_time_prekeys"][number]): boolean =>
          !this.#claimedPrekeys.has(prekey.prekey_id),
      );
    const prekey: PublicAgentKeyBundleDto["fallback_prekey"] =
      oneTime === undefined ? bundle.fallback_prekey : oneTime;
    this.#claimedPrekeys.add(prekey.prekey_id);
    const output: ClaimEncryptionPrekeyOutput = {
      bundle: structuredClone(bundle),
      claim_id: this.#claimId(),
      claimed_at: "2026-08-10T19:59:00.000Z",
      expires_at: "2026-08-10T20:02:00.000Z",
      prekey_class: prekey.prekey_class,
      prekey_id: prekey.prekey_id,
      provenance: {
        message_kind: "message",
        orchestrator_policy_id: null,
        sender_authority: "peer",
      },
      recipient_id: input.recipient_id,
    };
    this.#claims.set(output.claim_id, { input: structuredClone(input), output });
    return output;
  }

  public async put(input: PutEncryptedMessageInput): Promise<PutEncryptedMessageOutput> {
    const claim: StoredClaim | undefined = this.#claims.get(input.claim_id);
    if (claim === undefined) throw new Error("claim missing");
    const senderBundle: PublicAgentKeyBundleDto | undefined = this.#bundles.get(
      claim.input.sender_id,
    );
    if (senderBundle === undefined) throw new Error("sender bundle missing");
    await verifyHostedEncryptedEnvelope({
      claimInput: claim.input,
      claimOutput: claim.output,
      expectedBroadcastId: null,
      maxCiphertextBytes: this.capability().max_ciphertext_bytes,
      now: new Date(NOW),
      putInput: input,
      senderChain: signingChain(senderBundle),
      tenantId: TENANT_ID,
    });
    const key: string = `${claim.input.sender_id}\u0000${input.envelope.header.idempotency_key}`;
    const duplicate: EncryptedMessageDto | undefined = this.#idempotentMessages.get(key);
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate.envelope) !== JSON.stringify(input.envelope)) {
        throw new Error("idempotency conflict");
      }
      return { duplicate: true, message: duplicate, retention_days: 30, status: "stored" };
    }
    this.#sequence += 1;
    const message: EncryptedMessageDto = {
      envelope: structuredClone(input.envelope),
      read_at: null,
      sender_chain: signingChain(senderBundle),
      tenant_sequence: this.#sequence,
    };
    this.#messages.push(message);
    this.#idempotentMessages.set(key, message);
    return { duplicate: false, message, retention_days: 30, status: "stored" };
  }

  public inbox(input: GetEncryptedMessagesInput): EncryptedInboxOutput {
    const messages: readonly EncryptedMessageDto[] = this.#messages
      .filter(
        (message: EncryptedMessageDto): boolean =>
          message.envelope.header.recipient_id === input.agent_id &&
          message.tenant_sequence > input.after_sequence &&
          (!input.unread_only || message.read_at === null) &&
          (input.thread_id === undefined || message.envelope.header.thread_id === input.thread_id),
      )
      .slice(0, input.limit);
    const version: number = this.#messages.reduce(
      (current: number, message: EncryptedMessageDto): number =>
        message.envelope.header.recipient_id === input.agent_id && message.tenant_sequence > current
          ? message.tenant_sequence
          : current,
      0,
    );
    return { agent_id: input.agent_id, inbox_version: version, messages };
  }

  public mark(input: MarkMessagesReadInput): MarkMessagesReadOutput {
    let updated: number = 0;
    input.message_ids.forEach((messageId: string): void => {
      const index: number = this.#messages.findIndex(
        (message: EncryptedMessageDto): boolean =>
          message.envelope.header.message_id === messageId &&
          message.envelope.header.recipient_id === input.agent_id,
      );
      if (index < 0) return;
      const current: EncryptedMessageDto | undefined = this.#messages[index];
      if (current === undefined || current.read_at !== null) return;
      const changed: EncryptedMessageDto = { ...current, read_at: NOW };
      this.#messages[index] = changed;
      const key: string = `${changed.envelope.header.sender_id}\u0000${changed.envelope.header.idempotency_key}`;
      this.#idempotentMessages.set(key, changed);
      updated += 1;
    });
    return { read_at: NOW, updated };
  }
}

export class MemoryE2eeRemote implements E2eeProxyRemoteClient {
  readonly #backend: MemoryE2eeBackend;
  #closed: boolean = false;

  public constructor(backend: MemoryE2eeBackend) {
    this.#backend = backend;
  }

  #capture(tool: string, input: unknown): void {
    if (this.#closed) throw new Error("remote closed");
    this.#backend.captures.push({ input: structuredClone(input), tool });
  }

  public async capability(): Promise<E2eeCapabilityOutput> {
    this.#capture("get_e2ee_capability", {});
    return this.#backend.capability();
  }

  public async registerAgent(input: RegisterAgentInput): Promise<RegisterAgentOutput> {
    this.#capture("register_agent", input);
    return this.#backend.register(input);
  }

  public async listAgents(input: ListAgentsInput): Promise<ListAgentsOutput> {
    this.#capture("list_agents", input);
    return this.#backend.list();
  }

  public async getAgent(input: GetAgentInput): Promise<GetAgentOutput> {
    this.#capture("get_agent", input);
    return this.#backend.get(input);
  }

  public async endSession(input: EndSessionInput): Promise<EndSessionOutput> {
    this.#capture("end_session", input);
    return this.#backend.end(input);
  }

  public async closeAgent(input: CloseAgentInput): Promise<CloseAgentOutput> {
    this.#capture("close_agent", input);
    return this.#backend.closeAgent(input);
  }

  public async publishAgentKeyBundle(
    input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    this.#capture("publish_agent_key_bundle", input);
    return this.#backend.publish(input);
  }

  public async claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
  ): Promise<ClaimEncryptionPrekeyOutput> {
    this.#capture("claim_encryption_prekey", input);
    return this.#backend.claim(input);
  }

  public async putEncryptedMessage(
    input: PutEncryptedMessageInput,
  ): Promise<PutEncryptedMessageOutput> {
    this.#capture("put_encrypted_message", input);
    return await this.#backend.put(input);
  }

  public async getEncryptedMessages(
    input: GetEncryptedMessagesInput,
  ): Promise<EncryptedInboxOutput> {
    this.#capture("get_encrypted_messages", input);
    return this.#backend.inbox(input);
  }

  public async waitForEncryptedMessages(
    input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput> {
    this.#capture("wait_for_encrypted_messages", input);
    const inbox: EncryptedInboxOutput = this.#backend.inbox({
      after_sequence: input.after_sequence,
      agent_id: input.agent_id,
      limit: 100,
      unread_only: false,
    });
    return {
      agent_id: input.agent_id,
      messages: inbox.messages,
      timed_out: inbox.messages.length === 0,
    };
  }

  public async markMessagesRead(input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    this.#capture("mark_messages_read", input);
    return this.#backend.mark(input);
  }

  public async getInboxSummary(input: GetInboxSummaryInput): Promise<GetInboxSummaryOutput> {
    this.#capture("get_inbox_summary", input);
    const inbox: EncryptedInboxOutput = this.#backend.inbox({
      after_sequence: 0,
      agent_id: input.agent_id,
      limit: 500,
      unread_only: false,
    });
    return {
      agent_id: input.agent_id,
      inbox_version: inbox.inbox_version,
      newest_sequence: inbox.inbox_version === 0 ? null : inbox.inbox_version,
      unread_count: inbox.messages.filter(
        (message: EncryptedMessageDto): boolean => message.read_at === null,
      ).length,
    };
  }

  public async prepareEncryptedBroadcast(
    _input: PrepareEncryptedBroadcastInput,
  ): Promise<PrepareEncryptedBroadcastOutput> {
    throw new Error("broadcast unsupported in direct exchange harness");
  }

  public async putEncryptedBroadcastDelivery(
    _input: PutEncryptedBroadcastDeliveryInput,
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    throw new Error("broadcast unsupported in direct exchange harness");
  }

  public async commitEncryptedBroadcast(
    _input: CommitEncryptedBroadcastInput,
  ): Promise<CommitEncryptedBroadcastOutput> {
    throw new Error("broadcast unsupported in direct exchange harness");
  }

  public async cancelEncryptedBroadcast(
    _input: CancelEncryptedBroadcastInput,
  ): Promise<CancelEncryptedBroadcastOutput> {
    throw new Error("broadcast unsupported in direct exchange harness");
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }
}
