import type {
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
} from "../domain/contracts.js";
import type { SubmitFeedbackInput, SubmitFeedbackOutput } from "../domain/feedback-contracts.js";
import type {
  GetDelegationInput,
  GetDelegationOutput,
  GetOrchestratorInput,
  GetOrchestratorOutput,
} from "../hosted/orchestration-contracts.js";
import type {
  ClaimOrchestratorPrekeyInput,
  ClaimOrchestratorPrekeyOutput,
} from "./wire-orchestration.js";
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
    super(ENCRYPTION_CLAIM_EXPIRED_MESSAGE);
    this.name = "EncryptionClaimExpiredError";
  }
}

export const ENCRYPTION_CLAIM_EXPIRED_MESSAGE: string =
  "The encryption prekey claim expired; re-encryption is required";

export interface E2eeRemoteClient {
  capability(): Promise<E2eeCapabilityOutput>;
  publishAgentKeyBundle(input: PublishAgentKeyBundleInput): Promise<PublishAgentKeyBundleOutput>;
  claimEncryptionPrekey(input: ClaimEncryptionPrekeyInput): Promise<ClaimEncryptionPrekeyOutput>;
  claimOrchestratorPrekey?(
    input: ClaimOrchestratorPrekeyInput,
  ): Promise<ClaimOrchestratorPrekeyOutput>;
  putEncryptedMessage(input: PutEncryptedMessageInput): Promise<PutEncryptedMessageOutput>;
  getEncryptedMessages(input: GetEncryptedMessagesInput): Promise<EncryptedInboxOutput>;
  waitForEncryptedMessages(
    input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput>;
  acknowledgeMessages?(input: MarkMessagesReadInput): Promise<AcknowledgeEncryptedMessagesOutput>;
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

export interface E2eeProxyRemoteClient extends E2eeRemoteClient {
  closeAgent(input: CloseAgentInput): Promise<CloseAgentOutput>;
  endSession(input: EndSessionInput): Promise<EndSessionOutput>;
  getAgent(input: GetAgentInput): Promise<GetAgentOutput>;
  getDelegation?(input: GetDelegationInput): Promise<GetDelegationOutput>;
  getOrchestrator?(input: GetOrchestratorInput): Promise<GetOrchestratorOutput>;
  registerAgent(input: RegisterAgentInput): Promise<RegisterAgentOutput>;
  listAgents(input: ListAgentsInput): Promise<ListAgentsOutput>;
  submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackOutput>;
}
