import {
  type CommitEncryptedBroadcastOutput,
  CommitEncryptedBroadcastOutputSchema,
  type EncryptedBroadcastClaimDto,
  type EncryptedMessageDto,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
  type PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedBroadcastDeliveryOutputSchema,
  type PutEncryptedMessageInput,
} from "../../src/e2ee/wire-tools.js";
import {
  type CanaryE2eeIdentity,
  decryptCanaryE2eeMessage,
  encryptCanaryE2eeMessage,
} from "./e2ee-canary-crypto.js";
import {
  independentlyVerifyLiveEnvelope,
  liveEncryptedMessage,
  liveEncryptedMessages,
  type ProductionE2eeCanaryState,
  type ProductionE2eeEndpoints,
} from "./production-e2ee-canary-support.js";
import {
  assertCondition as assert,
  callProductionTool as call,
  productionToolNames as toolNames,
} from "./production-hosted-harness.js";

type BroadcastTarget = {
  readonly endpoint: ProductionE2eeEndpoints["orchestrator"];
  readonly identity: CanaryE2eeIdentity;
  readonly pairCounter: number;
};

type StagedDelivery = {
  readonly claim: EncryptedBroadcastClaimDto;
  readonly input: PutEncryptedMessageInput;
  readonly target: BroadcastTarget;
};

function targetForClaim(options: {
  readonly claim: EncryptedBroadcastClaimDto;
  readonly endpoints: ProductionE2eeEndpoints;
  readonly orchestratorId: string;
  readonly orchestratorIdentity: CanaryE2eeIdentity;
  readonly receiverId: string;
  readonly receiverIdentity: CanaryE2eeIdentity;
}): BroadcastTarget {
  if (options.claim.recipient_id === options.receiverId) {
    return {
      endpoint: options.endpoints.receiver,
      identity: options.receiverIdentity,
      pairCounter: 2,
    };
  }
  if (options.claim.recipient_id === options.orchestratorId) {
    return {
      endpoint: options.endpoints.orchestrator,
      identity: options.orchestratorIdentity,
      pairCounter: 1,
    };
  }
  throw new Error("Production encrypted broadcast crossed its expected audience");
}

export async function executeProductionEncryptedBroadcast(options: {
  readonly endpoints: ProductionE2eeEndpoints;
  readonly orchestratorId: string;
  readonly orchestratorIdentity: CanaryE2eeIdentity;
  readonly receiverId: string;
  readonly receiverIdentity: CanaryE2eeIdentity;
  readonly senderId: string;
  readonly senderIdentity: CanaryE2eeIdentity;
  readonly state: ProductionE2eeCanaryState;
  readonly unique: string;
}): Promise<void> {
  const tools: readonly string[] = await toolNames(options.endpoints.sender);
  for (const required of [
    "prepare_encrypted_broadcast",
    "put_encrypted_broadcast_delivery",
    "commit_encrypted_broadcast",
  ]) {
    assert(tools.includes(required), `Production encrypted broadcast tool ${required} is absent`);
  }
  const prepared: PrepareEncryptedBroadcastOutput = PrepareEncryptedBroadcastOutputSchema.parse(
    await call(options.endpoints.sender, "prepare_encrypted_broadcast", {
      audience: {},
      context: {
        branch: "production-canary",
        client: "codex",
        repository: "canary/source",
      },
      idempotency_key: `production-e2ee-broadcast-${options.unique}`,
      sender_id: options.senderId,
    }),
  );
  assert(!prepared.duplicate, "Production encrypted broadcast was unexpectedly a duplicate");
  assert(prepared.recipient_count === 2, "Encrypted broadcast fan-out was incomplete");
  const expectedRecipients: ReadonlySet<string> = new Set<string>([
    options.orchestratorId,
    options.receiverId,
  ]);
  assert(
    prepared.claims.every((claim: EncryptedBroadcastClaimDto): boolean =>
      expectedRecipients.has(claim.recipient_id),
    ),
    "Encrypted broadcast selected an unexpected recipient",
  );
  const sentinel: string = `paid-e2ee-production-broadcast-${options.unique}`;
  const deliveries: StagedDelivery[] = [];
  for (const claim of prepared.claims) {
    const target: BroadcastTarget = targetForClaim({
      claim,
      endpoints: options.endpoints,
      orchestratorId: options.orchestratorId,
      orchestratorIdentity: options.orchestratorIdentity,
      receiverId: options.receiverId,
      receiverIdentity: options.receiverIdentity,
    });
    const input: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
      branch: "production-canary",
      broadcastId: prepared.broadcast_id,
      claim,
      idempotencyKey: `production-e2ee-broadcast-${options.unique}-${claim.recipient_id}`,
      pairCounter: target.pairCounter,
      plaintext: sentinel,
      recipient: target.identity,
      repository: "canary/source",
      sender: options.senderIdentity,
      senderId: options.senderId,
      tenantId: options.state.tenantId,
      threadId: prepared.thread_id,
    });
    assert(!JSON.stringify(input).includes(sentinel), "Broadcast plaintext reached the server");
    const stored: PutEncryptedBroadcastDeliveryOutput =
      PutEncryptedBroadcastDeliveryOutputSchema.parse(
        await call(options.endpoints.sender, "put_encrypted_broadcast_delivery", {
          broadcast_id: prepared.broadcast_id,
          claim_id: claim.claim_id,
          envelope: input.envelope,
        }),
      );
    assert(stored.accepted && !stored.duplicate, "Encrypted broadcast staging was rejected");
    assert(stored.recipient_id === claim.recipient_id, "Broadcast acknowledgement crossed agents");
    deliveries.push({ claim, input, target });
  }
  for (const delivery of deliveries) {
    const stagedVisible: boolean = (
      await liveEncryptedMessages(delivery.target.endpoint, delivery.claim.recipient_id)
    ).some(
      (message: EncryptedMessageDto): boolean =>
        message.envelope.header.broadcast_id === prepared.broadcast_id,
    );
    assert(!stagedVisible, "A partial encrypted broadcast became visible before commit");
  }
  const committed: CommitEncryptedBroadcastOutput = CommitEncryptedBroadcastOutputSchema.parse(
    await call(options.endpoints.sender, "commit_encrypted_broadcast", {
      broadcast_id: prepared.broadcast_id,
    }),
  );
  assert(
    committed.broadcast_id === prepared.broadcast_id && committed.recipient_count === 2,
    "Encrypted broadcast commit acknowledgement was inconsistent",
  );
  for (const delivery of deliveries) {
    const message: EncryptedMessageDto = await liveEncryptedMessage(
      delivery.target.endpoint,
      delivery.claim.recipient_id,
      delivery.input.envelope.header.message_id,
    );
    await independentlyVerifyLiveEnvelope(message, delivery.claim);
    assert(
      (await decryptCanaryE2eeMessage(
        message,
        options.senderIdentity,
        delivery.target.identity,
      )) === sentinel,
      "Encrypted broadcast recipient could not decrypt the production sentinel",
    );
  }
}
