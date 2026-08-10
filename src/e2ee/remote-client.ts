import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../domain/contracts.js";
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
  WaitForEncryptedMessagesInput,
  WaitForEncryptedMessagesOutput,
} from "./wire-tools.js";

export class EncryptionClaimExpiredError extends Error {
  public constructor() {
    super("The encryption prekey claim expired; re-encryption is required");
  }
}

export interface E2eeRemoteClient {
  capability(): Promise<E2eeCapabilityOutput>;
  publishAgentKeyBundle(input: PublishAgentKeyBundleInput): Promise<PublishAgentKeyBundleOutput>;
  claimEncryptionPrekey(input: ClaimEncryptionPrekeyInput): Promise<ClaimEncryptionPrekeyOutput>;
  putEncryptedMessage(input: PutEncryptedMessageInput): Promise<PutEncryptedMessageOutput>;
  getEncryptedMessages(input: GetEncryptedMessagesInput): Promise<EncryptedInboxOutput>;
  waitForEncryptedMessages(
    input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput>;
  markMessagesRead(input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput>;
  prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
  ): Promise<PrepareEncryptedBroadcastOutput>;
  putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
  ): Promise<PutEncryptedBroadcastDeliveryOutput>;
  commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
  ): Promise<CommitEncryptedBroadcastOutput>;
  cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
  ): Promise<CancelEncryptedBroadcastOutput>;
  getInboxSummary(input: GetInboxSummaryInput): Promise<GetInboxSummaryOutput>;
  close(): Promise<void>;
}
