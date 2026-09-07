import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../domain/contracts.js";
import type { TenantId } from "../domain/value-objects.js";
import type {
  AcknowledgeEncryptedMessagesOutput,
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  ClaimedProvenanceDto,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
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
} from "../e2ee/wire-tools.js";
import type { Awaitable, InboxSubscription } from "./message-store.js";

export type EncryptedInboxUpdateHandler = (sequence: number) => Promise<void>;

export type E2eeOrchestrationScope = {
  readonly machineName: string | null;
  readonly personalId: string;
  readonly repositoryName: string | null;
};

export type E2eeWriteAuthorization = {
  readonly boundSenderId: string | null;
  readonly orchestrationScope: E2eeOrchestrationScope | null;
  readonly provenance: ClaimedProvenanceDto;
};

export interface E2eeMessageStore {
  scopeE2ee(tenantId: TenantId): E2eeMessageStore;
  publishAgentKeyBundle(input: PublishAgentKeyBundleInput): Awaitable<PublishAgentKeyBundleOutput>;
  claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
    authorization?: E2eeWriteAuthorization,
  ): Awaitable<ClaimEncryptionPrekeyOutput>;
  putEncryptedMessage(
    input: PutEncryptedMessageInput,
    authorization?: E2eeWriteAuthorization,
  ): Awaitable<PutEncryptedMessageOutput>;
  getEncryptedMessages(input: GetEncryptedMessagesInput): Awaitable<EncryptedInboxOutput>;
  acknowledgeEncryptedMessages(
    input: MarkMessagesReadInput,
  ): Awaitable<AcknowledgeEncryptedMessagesOutput>;
  markEncryptedMessagesRead(input: MarkMessagesReadInput): Awaitable<MarkMessagesReadOutput>;
  prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
    authorization?: E2eeWriteAuthorization,
  ): Awaitable<PrepareEncryptedBroadcastOutput>;
  putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
    authorization?: E2eeWriteAuthorization,
  ): Awaitable<PutEncryptedBroadcastDeliveryOutput>;
  commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
    authorization?: E2eeWriteAuthorization,
  ): Awaitable<CommitEncryptedBroadcastOutput>;
  cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
    authorization?: E2eeWriteAuthorization,
  ): Awaitable<CancelEncryptedBroadcastOutput>;
  getEncryptedInboxSummary(input: GetInboxSummaryInput): Awaitable<GetInboxSummaryOutput>;
  watchEncryptedInbox(
    agentId: string,
    afterSequence: number,
    handler: EncryptedInboxUpdateHandler,
  ): Awaitable<InboxSubscription>;
  close(): Awaitable<void>;
}

export interface E2eeMessageStoreProvider {
  scopeE2ee(tenantId: TenantId): E2eeMessageStore;
}

export function isE2eeMessageStoreProvider(value: unknown): value is E2eeMessageStoreProvider {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "scopeE2ee") === "function";
}
