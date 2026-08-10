import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../domain/contracts.js";
import type { TenantId } from "../domain/value-objects.js";
import type {
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
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

export interface E2eeMessageStore {
  scopeE2ee(tenantId: TenantId): E2eeMessageStore;
  publishAgentKeyBundle(input: PublishAgentKeyBundleInput): Awaitable<PublishAgentKeyBundleOutput>;
  claimEncryptionPrekey(input: ClaimEncryptionPrekeyInput): Awaitable<ClaimEncryptionPrekeyOutput>;
  putEncryptedMessage(input: PutEncryptedMessageInput): Awaitable<PutEncryptedMessageOutput>;
  getEncryptedMessages(input: GetEncryptedMessagesInput): Awaitable<EncryptedInboxOutput>;
  markEncryptedMessagesRead(input: MarkMessagesReadInput): Awaitable<MarkMessagesReadOutput>;
  prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
  ): Awaitable<PrepareEncryptedBroadcastOutput>;
  putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
  ): Awaitable<PutEncryptedBroadcastDeliveryOutput>;
  commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
  ): Awaitable<CommitEncryptedBroadcastOutput>;
  cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
  ): Awaitable<CancelEncryptedBroadcastOutput>;
  getEncryptedInboxSummary(input: GetInboxSummaryInput): Awaitable<GetInboxSummaryOutput>;
  watchEncryptedInbox(
    agentId: string,
    afterSequence: number,
    handler: EncryptedInboxUpdateHandler,
  ): Awaitable<InboxSubscription>;
  close(): Awaitable<void>;
}
