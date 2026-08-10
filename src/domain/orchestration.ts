import { randomUUID } from "node:crypto";

import { z } from "zod";

const PersonalIdValueSchema: z.ZodString = z.string().uuid();
const OrchestratorPolicyIdValueSchema: z.ZodString = z.string().uuid();

export const SenderAuthoritySchema: z.ZodEnum<{
  orchestrator: "orchestrator";
  peer: "peer";
}> = z.enum(["peer", "orchestrator"]);

export const MessageKindSchema: z.ZodEnum<{
  message: "message";
  orchestration_request: "orchestration_request";
}> = z.enum(["message", "orchestration_request"]);

export const OrchestrationScopeKindSchema: z.ZodEnum<{
  organization: "organization";
  personal: "personal";
}> = z.enum(["organization", "personal"]);

export type SenderAuthority = z.infer<typeof SenderAuthoritySchema>;
export type MessageKind = z.infer<typeof MessageKindSchema>;
export type OrchestrationScopeKind = z.infer<typeof OrchestrationScopeKindSchema>;

export class PersonalId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): PersonalId {
    return new PersonalId(PersonalIdValueSchema.parse(input));
  }

  public static generate(): PersonalId {
    return PersonalId.parse(randomUUID());
  }

  public equals(other: PersonalId): boolean {
    return this.value === other.value;
  }
}

export class OrchestratorPolicyId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): OrchestratorPolicyId {
    return new OrchestratorPolicyId(OrchestratorPolicyIdValueSchema.parse(input));
  }

  public equals(other: OrchestratorPolicyId): boolean {
    return this.value === other.value;
  }
}

export type MessageProvenance = {
  readonly messageKind: MessageKind;
  readonly orchestratorPolicyId: OrchestratorPolicyId | null;
  readonly senderAuthority: SenderAuthority;
};

export function ordinaryMessageProvenance(
  senderAuthority: SenderAuthority = "peer",
): MessageProvenance {
  return {
    messageKind: "message",
    orchestratorPolicyId: null,
    senderAuthority,
  };
}

export function validateMessageProvenance(provenance: MessageProvenance): void {
  const policyPresent: boolean = provenance.orchestratorPolicyId !== null;
  if (provenance.messageKind === "orchestration_request" && !policyPresent) {
    throw new Error("An orchestration request requires a policy identifier");
  }
  if (provenance.messageKind === "message" && policyPresent) {
    throw new Error("An ordinary message cannot reference an orchestrator policy");
  }
  if (provenance.messageKind === "orchestration_request" && provenance.senderAuthority !== "peer") {
    throw new Error("An orchestration request must originate from peer authority");
  }
}
