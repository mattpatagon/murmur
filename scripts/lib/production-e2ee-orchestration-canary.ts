import {
  type ClaimOrchestratorPrekeyOutput,
  ClaimOrchestratorPrekeyOutputSchema,
} from "../../src/e2ee/wire-orchestration.js";
import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityOutputSchema,
  type EncryptedMessageDto,
  type PutEncryptedMessageInput,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
} from "../../src/e2ee/wire-tools.js";
import {
  type EffectiveOrchestratorDto,
  type GetOrchestratorOutput,
  GetOrchestratorOutputSchema,
} from "../../src/hosted/orchestration-contracts.js";
import {
  type CanaryE2eeIdentity,
  decryptCanaryE2eeMessage,
  encryptCanaryE2eeMessage,
} from "./e2ee-canary-crypto.js";
import {
  independentlyVerifyLiveEnvelope,
  liveEncryptedMessage,
  type ProductionE2eeCanaryState,
  type ProductionE2eeEndpoints,
} from "./production-e2ee-canary-support.js";
import {
  assertCondition as assert,
  callProductionTool as call,
  productionToolNames as toolNames,
} from "./production-hosted-harness.js";

function assertOrchestrationClaim(
  claim: ClaimEncryptionPrekeyOutput,
  orchestrator: EffectiveOrchestratorDto,
): void {
  assert(claim.recipient_id === orchestrator.agent_id, "Orchestrator claim crossed agents");
  assert(
    claim.provenance.message_kind === "orchestration_request" &&
      claim.provenance.orchestrator_policy_id === orchestrator.policy_id &&
      claim.provenance.sender_authority === "peer",
    "Orchestrator claim omitted its server-issued provenance",
  );
}

function assertReplyClaim(claim: ClaimEncryptionPrekeyOutput, senderId: string): void {
  assert(claim.recipient_id === senderId, "Orchestrator reply claim crossed agents");
  assert(
    claim.provenance.message_kind === "message" &&
      claim.provenance.orchestrator_policy_id === null &&
      claim.provenance.sender_authority === "orchestrator",
    "Orchestrator reply omitted its server-issued authority",
  );
}

export async function executeProductionEncryptedOrchestration(options: {
  readonly endpoints: ProductionE2eeEndpoints;
  readonly orchestratorId: string;
  readonly orchestratorIdentity: CanaryE2eeIdentity;
  readonly policyId: string;
  readonly senderId: string;
  readonly senderIdentity: CanaryE2eeIdentity;
  readonly state: ProductionE2eeCanaryState;
  readonly unique: string;
}): Promise<void> {
  const senderTools: readonly string[] = await toolNames(options.endpoints.sender);
  assert(senderTools.includes("get_orchestrator"), "Encrypted orchestrator lookup is absent");
  assert(
    senderTools.includes("claim_orchestrator_prekey"),
    "Encrypted orchestrator claim is absent",
  );
  assert(!senderTools.includes("ask_orchestrator"), "Plaintext orchestrator tool survived E2E");
  const capability: E2eeCapabilityOutput = E2eeCapabilityOutputSchema.parse(
    await call(options.endpoints.orchestrator, "get_e2ee_capability", {}),
  );
  assert(capability.caller_authority === "orchestrator", "Orchestrator authority was lost");
  const lookup: GetOrchestratorOutput = GetOrchestratorOutputSchema.parse(
    await call(options.endpoints.sender, "get_orchestrator", {}),
  );
  const orchestrator: EffectiveOrchestratorDto | null = lookup.orchestrator;
  assert(lookup.caller_authority === "peer", "Peer acquired orchestrator authority");
  assert(orchestrator !== null, "Production orchestration policy did not resolve");
  assert(
    orchestrator.agent_id === options.orchestratorId && orchestrator.policy_id === options.policyId,
    "Production orchestration route changed unexpectedly",
  );
  const claimed: ClaimOrchestratorPrekeyOutput = ClaimOrchestratorPrekeyOutputSchema.parse(
    await call(options.endpoints.sender, "claim_orchestrator_prekey", {
      context: {
        branch: "production-canary",
        client: "codex",
        repository: "canary/source",
      },
      sender_id: options.senderId,
    }),
  );
  assert(
    JSON.stringify(claimed.orchestrator) === JSON.stringify(orchestrator),
    "Orchestrator changed between lookup and prekey claim",
  );
  assertOrchestrationClaim(claimed.claim, orchestrator);
  const question: string = `paid-e2ee-production-orchestrator-question-${options.unique}`;
  const encryptedQuestion: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
    claim: claimed.claim,
    idempotencyKey: `production-e2ee-orchestrator-question-${options.unique}`,
    pairCounter: 2,
    plaintext: question,
    recipient: options.orchestratorIdentity,
    repository: "canary/source",
    sender: options.senderIdentity,
    senderId: options.senderId,
    tenantId: options.state.tenantId,
  });
  assert(
    !JSON.stringify(encryptedQuestion).includes(question),
    "Orchestrator question plaintext reached the server",
  );
  const storedQuestion: PutEncryptedMessageOutput = PutEncryptedMessageOutputSchema.parse(
    await call(options.endpoints.sender, "put_encrypted_message", encryptedQuestion),
  );
  assert(!storedQuestion.duplicate, "Encrypted orchestrator question was unexpectedly duplicate");
  const receivedQuestion: EncryptedMessageDto = await liveEncryptedMessage(
    options.endpoints.orchestrator,
    options.orchestratorId,
    encryptedQuestion.envelope.header.message_id,
  );
  await independentlyVerifyLiveEnvelope(receivedQuestion, claimed.claim);
  assert(
    (await decryptCanaryE2eeMessage(
      receivedQuestion,
      options.senderIdentity,
      options.orchestratorIdentity,
    )) === question,
    "Orchestrator could not decrypt the production question",
  );

  const replyClaim: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
    await call(options.endpoints.orchestrator, "claim_encryption_prekey", {
      context: {
        branch: "production-canary",
        client: "codex",
        repository: "canary/orchestrator",
      },
      recipient_id: options.senderId,
      sender_id: options.orchestratorId,
    }),
  );
  assertReplyClaim(replyClaim, options.senderId);
  const reply: string = `paid-e2ee-production-orchestrator-reply-${options.unique}`;
  const encryptedReply: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
    claim: replyClaim,
    idempotencyKey: `production-e2ee-orchestrator-reply-${options.unique}`,
    pairCounter: 1,
    plaintext: reply,
    recipient: options.senderIdentity,
    repository: "canary/orchestrator",
    sender: options.orchestratorIdentity,
    senderId: options.orchestratorId,
    tenantId: options.state.tenantId,
    threadId: encryptedQuestion.envelope.header.thread_id,
  });
  assert(
    !JSON.stringify(encryptedReply).includes(reply),
    "Orchestrator reply plaintext reached the server",
  );
  const storedReply: PutEncryptedMessageOutput = PutEncryptedMessageOutputSchema.parse(
    await call(options.endpoints.orchestrator, "put_encrypted_message", encryptedReply),
  );
  assert(!storedReply.duplicate, "Encrypted orchestrator reply was unexpectedly duplicate");
  const receivedReply: EncryptedMessageDto = await liveEncryptedMessage(
    options.endpoints.sender,
    options.senderId,
    encryptedReply.envelope.header.message_id,
  );
  await independentlyVerifyLiveEnvelope(receivedReply, replyClaim);
  assert(
    (await decryptCanaryE2eeMessage(
      receivedReply,
      options.orchestratorIdentity,
      options.senderIdentity,
    )) === reply,
    "Peer could not decrypt the production orchestrator reply",
  );
}
