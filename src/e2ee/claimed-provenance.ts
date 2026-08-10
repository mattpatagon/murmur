import type { SenderAuthority } from "../domain/orchestration.js";
import type { ClaimedProvenanceDto } from "./wire-tools.js";

export function ordinaryClaimedProvenance(senderAuthority: SenderAuthority): ClaimedProvenanceDto {
  return {
    message_kind: "message",
    orchestrator_policy_id: null,
    sender_authority: senderAuthority,
  };
}

export function orchestrationClaimedProvenance(policyId: string): ClaimedProvenanceDto {
  return {
    message_kind: "orchestration_request",
    orchestrator_policy_id: policyId,
    sender_authority: "peer",
  };
}
