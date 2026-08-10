import type { Clock, Instant } from "../domain/value-objects.js";
import {
  type EffectiveOrchestratorDto,
  type GetOrchestratorOutput,
  GetOrchestratorOutputSchema,
} from "../hosted/orchestration-contracts.js";
import { orchestrationClaimedProvenance } from "./claimed-provenance.js";
import type { LocalE2eeVault } from "./local-vault.js";
import type { StoredOrchestrationRoute } from "./local-vault-settings.js";
import {
  type ProxyAskOrchestratorOutput,
  ProxyAskOrchestratorOutputSchema,
  sentMessageToProxyDto,
} from "./proxy-contracts.js";
import {
  defaultProxySendOptions,
  type ProxySendInput,
  type ProxySendOptions,
  type ProxySendResult,
  sendEncryptedMessage,
} from "./proxy-send.js";
import type { E2eeProxyRemoteClient } from "./remote-client.js";
import {
  type ClaimOrchestratorPrekeyOutput,
  ClaimOrchestratorPrekeyOutputSchema,
} from "./wire-orchestration.js";
import type { ClaimEncryptionPrekeyOutput } from "./wire-tools.js";

function sameOrchestrator(
  expected: EffectiveOrchestratorDto,
  actual: EffectiveOrchestratorDto,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export async function askEncryptedOrchestrator(
  vault: LocalE2eeVault,
  remote: E2eeProxyRemoteClient,
  clock: Clock,
  input: Omit<ProxySendInput, "recipientId">,
  trustOnFirstUse: boolean,
): Promise<ProxyAskOrchestratorOutput> {
  if (input.idempotencyKey === null) {
    throw new Error("Encrypted orchestrator questions require an idempotency key");
  }
  const getOrchestrator: E2eeProxyRemoteClient["getOrchestrator"] = remote.getOrchestrator;
  const claimOrchestrator: E2eeProxyRemoteClient["claimOrchestratorPrekey"] =
    remote.claimOrchestratorPrekey;
  if (getOrchestrator === undefined || claimOrchestrator === undefined) {
    throw new Error("Encrypted orchestration is unavailable on this Murmur server");
  }
  const now: Instant = clock.now();
  const storedRoute: StoredOrchestrationRoute | null = vault.settings.getOrchestrationRoute(
    input.idempotencyKey,
    now.toISOString(),
  );
  let orchestrator: EffectiveOrchestratorDto;
  if (storedRoute === null) {
    const lookup: GetOrchestratorOutput = GetOrchestratorOutputSchema.parse(
      await getOrchestrator.call(remote, {}),
    );
    if (lookup.caller_authority !== "peer" || lookup.orchestrator === null) {
      throw new Error("No active orchestrator is configured for this credential");
    }
    orchestrator = vault.settings.bindOrchestrationRoute(
      input.idempotencyKey,
      lookup.orchestrator,
      now.addDays(31).toISOString(),
      now.toISOString(),
    ).orchestrator;
  } else {
    orchestrator = storedRoute.orchestrator;
  }
  const sendInput: ProxySendInput = { ...input, recipientId: orchestrator.agent_id };
  const defaults: ProxySendOptions = defaultProxySendOptions();
  const options: ProxySendOptions = {
    ...defaults,
    claimProvider: async (claimInput: ProxySendInput): Promise<ClaimEncryptionPrekeyOutput> => {
      const output: ClaimOrchestratorPrekeyOutput = ClaimOrchestratorPrekeyOutputSchema.parse(
        await claimOrchestrator.call(remote, {
          context: claimInput.context,
          sender_id: claimInput.senderId,
          ...(claimInput.sessionKey === undefined ? {} : { session_key: claimInput.sessionKey }),
        }),
      );
      if (
        !sameOrchestrator(orchestrator, output.orchestrator) ||
        output.claim.recipient_id !== orchestrator.agent_id
      ) {
        throw new Error("Hosted Murmur changed the effective orchestrator during encryption");
      }
      return output.claim;
    },
    expectedProvenance: orchestrationClaimedProvenance(orchestrator.policy_id),
    trustOnFirstUse,
  };
  const sent: ProxySendResult = await sendEncryptedMessage(
    vault,
    remote,
    clock,
    sendInput,
    options,
  );
  return ProxyAskOrchestratorOutputSchema.parse({
    duplicate: sent.output.duplicate,
    message: sentMessageToProxyDto(sent),
    orchestrator,
    retention_days: sent.output.retention_days,
    status: sent.output.status,
  });
}
