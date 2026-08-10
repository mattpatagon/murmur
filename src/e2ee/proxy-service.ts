import {
  agentClientFromInput,
  type BroadcastMessageInput,
  branchNameFromInput,
  type GetMessagesInput,
  type ListAgentsInput,
  type ListAgentsOutput,
  type MarkMessagesReadInput,
  type MarkMessagesReadOutput,
  type MessageContextDto,
  type RegisterAgentInput,
  type RegisterAgentOutput,
  repositoryNameFromInput,
  type SendMessageInput,
  type WaitForMessagesInput,
} from "../domain/contracts.js";
import type { AgentClient, BranchName, Clock, RepositoryName } from "../domain/value-objects.js";
import type { LocalE2eeVault } from "./local-vault.js";
import {
  broadcastToProxyOutput,
  decryptedMessageToProxyDto,
  type ProxyBroadcastOutput,
  type ProxyInboxOutput,
  ProxyInboxOutputSchema,
  type ProxySendMessageOutput,
  ProxySendMessageOutputSchema,
  type ProxyWaitForMessagesOutput,
  ProxyWaitForMessagesOutputSchema,
  sentMessageToProxyDto,
} from "./proxy-contracts.js";
import {
  broadcastEncryptedMessage,
  type ProxyBroadcastInput,
  type ProxyBroadcastResult,
} from "./proxy-broadcast.js";
import { publishLocalIdentity } from "./proxy-identity.js";
import {
  markEncryptedMessagesRead,
  receiveEncryptedMessages,
  type ReceiveEncryptedMessagesResult,
  type WaitForDecryptedMessagesResult,
  waitForDecryptedMessages,
} from "./proxy-receive.js";
import {
  defaultProxySendOptions,
  sendEncryptedMessage,
  type ProxySendInput,
  type ProxySendOptions,
  type ProxySendResult,
} from "./proxy-send.js";
import type { E2eeProxyRemoteClient } from "./remote-client.js";
import type { E2eeMessageContextDto } from "./wire-tools.js";

export type E2eeProxyServiceDependencies = {
  readonly branchName: BranchName | null;
  readonly client: AgentClient;
  readonly clock: Clock;
  readonly remote: E2eeProxyRemoteClient;
  readonly repositoryName: RepositoryName | null;
  readonly trustOnFirstUse: boolean;
  readonly vault: LocalE2eeVault;
};

export interface E2eeProxyOperations {
  registerAgent(input: RegisterAgentInput): Promise<RegisterAgentOutput>;
  listAgents(input: ListAgentsInput): Promise<ListAgentsOutput>;
  sendMessage(input: SendMessageInput): Promise<ProxySendMessageOutput>;
  broadcastMessage(input: BroadcastMessageInput): Promise<ProxyBroadcastOutput>;
  getMessages(input: GetMessagesInput): Promise<ProxyInboxOutput>;
  waitForMessages(input: WaitForMessagesInput): Promise<ProxyWaitForMessagesOutput>;
  markMessagesRead(input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput>;
  close(): Promise<void>;
}

function requiredContext(
  input: MessageContextDto | undefined,
  dependencies: E2eeProxyServiceDependencies,
): E2eeMessageContextDto {
  const repositoryName: RepositoryName | null = repositoryNameFromInput(
    input,
    dependencies.repositoryName,
  );
  if (repositoryName === null) {
    throw new Error(
      "Message repository context is required. Supply context.repository or launch the E2E proxy from a repository.",
    );
  }
  const branchName: BranchName | null = branchNameFromInput(input, dependencies.branchName);
  if (branchName === null) {
    throw new Error(
      "Message branch context is required. Supply context.branch or launch the E2E proxy from a repository branch.",
    );
  }
  const client: AgentClient | null = agentClientFromInput(input, dependencies.client);
  if (client === null) throw new Error("Message client context is required");
  return {
    branch: branchName.value,
    client: client.value,
    repository: repositoryName.value,
  };
}

function sendOptions(trustOnFirstUse: boolean): ProxySendOptions {
  return { ...defaultProxySendOptions(), trustOnFirstUse };
}

export class E2eeProxyService implements E2eeProxyOperations {
  readonly #dependencies: E2eeProxyServiceDependencies;
  #closed: boolean = false;

  public constructor(dependencies: E2eeProxyServiceDependencies) {
    this.#dependencies = dependencies;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("The local E2E proxy is closed");
  }

  public async registerAgent(input: RegisterAgentInput): Promise<RegisterAgentOutput> {
    this.#ensureOpen();
    const output: RegisterAgentOutput = await this.#dependencies.remote.registerAgent(input);
    await publishLocalIdentity(
      this.#dependencies.vault,
      this.#dependencies.remote,
      output.agent.agent_id,
      this.#dependencies.clock.now(),
    );
    return output;
  }

  public async listAgents(input: ListAgentsInput): Promise<ListAgentsOutput> {
    this.#ensureOpen();
    return await this.#dependencies.remote.listAgents(input);
  }

  public async sendMessage(input: SendMessageInput): Promise<ProxySendMessageOutput> {
    this.#ensureOpen();
    const encryptedInput: ProxySendInput = {
      content: input.content,
      context: requiredContext(input.context, this.#dependencies),
      idempotencyKey: input.idempotency_key === undefined ? null : input.idempotency_key,
      recipientId: input.recipient_id,
      senderId: input.sender_id,
      threadId: input.thread_id === undefined ? null : input.thread_id,
    };
    const result: ProxySendResult = await sendEncryptedMessage(
      this.#dependencies.vault,
      this.#dependencies.remote,
      this.#dependencies.clock,
      encryptedInput,
      sendOptions(this.#dependencies.trustOnFirstUse),
    );
    return ProxySendMessageOutputSchema.parse({
      duplicate: result.output.duplicate,
      message: sentMessageToProxyDto(result),
      retention_days: result.output.retention_days,
      status: result.output.status,
    });
  }

  public async broadcastMessage(input: BroadcastMessageInput): Promise<ProxyBroadcastOutput> {
    this.#ensureOpen();
    const audience: ProxyBroadcastOutput["audience"] =
      input.audience === undefined ? {} : input.audience;
    const encryptedInput: ProxyBroadcastInput = {
      audience,
      content: input.content,
      context: requiredContext(input.context, this.#dependencies),
      idempotencyKey: input.idempotency_key === undefined ? null : input.idempotency_key,
      senderId: input.sender_id,
      threadId: input.thread_id === undefined ? null : input.thread_id,
    };
    const result: ProxyBroadcastResult = await broadcastEncryptedMessage(
      this.#dependencies.vault,
      this.#dependencies.remote,
      this.#dependencies.clock,
      encryptedInput,
      sendOptions(this.#dependencies.trustOnFirstUse),
    );
    return broadcastToProxyOutput(result, audience);
  }

  public async getMessages(input: GetMessagesInput): Promise<ProxyInboxOutput> {
    this.#ensureOpen();
    const result: ReceiveEncryptedMessagesResult = await receiveEncryptedMessages(
      this.#dependencies.vault,
      this.#dependencies.remote,
      this.#dependencies.clock,
      input,
      this.#dependencies.trustOnFirstUse,
    );
    return ProxyInboxOutputSchema.parse({
      agent_id: result.agentId,
      inbox_version: result.inboxVersion,
      messages: result.messages.map(decryptedMessageToProxyDto),
    });
  }

  public async waitForMessages(input: WaitForMessagesInput): Promise<ProxyWaitForMessagesOutput> {
    this.#ensureOpen();
    const result: WaitForDecryptedMessagesResult = await waitForDecryptedMessages(
      this.#dependencies.vault,
      this.#dependencies.remote,
      this.#dependencies.clock,
      input,
      this.#dependencies.trustOnFirstUse,
    );
    return ProxyWaitForMessagesOutputSchema.parse({
      agent_id: result.agentId,
      messages: result.messages.map(decryptedMessageToProxyDto),
      timed_out: result.timedOut,
    });
  }

  public async markMessagesRead(input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    this.#ensureOpen();
    return await markEncryptedMessagesRead(
      this.#dependencies.vault,
      this.#dependencies.remote,
      input,
    );
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let vaultFailed: boolean = false;
    try {
      this.#dependencies.vault.close();
    } catch (_error: unknown) {
      vaultFailed = true;
    }
    let remoteFailed: boolean = false;
    try {
      await this.#dependencies.remote.close();
    } catch (_error: unknown) {
      remoteFailed = true;
    }
    if (vaultFailed || remoteFailed) throw new Error("The local E2E proxy shutdown failed");
  }
}
