import { describe, expect, test } from "bun:test";

import {
  OrchestratorPolicyId,
  ordinaryMessageProvenance,
  validateMessageProvenance,
} from "../src/domain/orchestration.js";
import { CreateTokenInputSchema } from "../src/hosted/contracts.js";
import {
  EffectiveOrchestratorDtoSchema,
  OrchestratorScopeInputSchema,
  SetOrchestratorPolicyInputSchema,
} from "../src/hosted/orchestration-contracts.js";

const PERSONAL_ID: string = "10000000-0000-4000-8000-000000000001";
const POLICY_ID: string = "20000000-0000-4000-8000-000000000001";

describe("orchestration boundary contracts", (): void => {
  test("accepts all eight owner, repository, and machine scope shapes", (): void => {
    const scopes: readonly unknown[] = [
      { scope_kind: "organization" },
      { machine: "build-host-01", scope_kind: "organization" },
      { repository: "mattpatagon/murmur", scope_kind: "organization" },
      {
        machine: "build-host-01",
        repository: "mattpatagon/murmur",
        scope_kind: "organization",
      },
      { personal_id: PERSONAL_ID, scope_kind: "personal" },
      { machine: "build-host-01", personal_id: PERSONAL_ID, scope_kind: "personal" },
      {
        personal_id: PERSONAL_ID,
        repository: "mattpatagon/murmur",
        scope_kind: "personal",
      },
      {
        machine: "build-host-01",
        personal_id: PERSONAL_ID,
        repository: "mattpatagon/murmur",
        scope_kind: "personal",
      },
    ];
    scopes.forEach((scope: unknown): void => {
      expect(OrchestratorScopeInputSchema.safeParse(scope).success).toBe(true);
    });
  });

  test("rejects ambiguous, malformed, oversized, and extended policy inputs", (): void => {
    const invalidScopes: readonly unknown[] = [
      { personal_id: PERSONAL_ID, scope_kind: "organization" },
      { scope_kind: "personal" },
      { repository: "missing-slash", scope_kind: "organization" },
      { machine: "contains spaces", scope_kind: "organization" },
      { machine: "x".repeat(201), scope_kind: "organization" },
      { extra: true, scope_kind: "organization" },
    ];
    invalidScopes.forEach((scope: unknown): void => {
      expect(OrchestratorScopeInputSchema.safeParse(scope).success).toBe(false);
    });
    expect(
      SetOrchestratorPolicyInputSchema.safeParse({
        instructions: "é".repeat(4_097),
        orchestrator_key_id: "boss_key_1",
        scope_kind: "organization",
      }).success,
    ).toBe(false);
    expect(
      SetOrchestratorPolicyInputSchema.safeParse({
        instructions: "Decide routine coordination; escalate security changes.",
        orchestrator_key_id: "short",
        scope_kind: "organization",
      }).success,
    ).toBe(false);
  });

  test("keeps private instructions out of the public effective-orchestrator DTO", (): void => {
    const publicDto: Record<string, unknown> = {
      agent_id: "boss-agent",
      policy_id: POLICY_ID,
      scope: { personal_id: null, repository: null, scope_kind: "organization" },
    };
    expect(EffectiveOrchestratorDtoSchema.safeParse(publicDto).success).toBe(true);
    expect(
      EffectiveOrchestratorDtoSchema.safeParse({
        ...publicDto,
        instructions: "private human instructions",
      }).success,
    ).toBe(false);
  });

  test("enforces provenance combinations and prevents public boss-token minting", (): void => {
    const policyId: OrchestratorPolicyId = OrchestratorPolicyId.parse(POLICY_ID);
    expect((): void => validateMessageProvenance(ordinaryMessageProvenance("peer"))).not.toThrow();
    expect((): void =>
      validateMessageProvenance(ordinaryMessageProvenance("orchestrator")),
    ).not.toThrow();
    expect((): void =>
      validateMessageProvenance({
        messageKind: "orchestration_request",
        orchestratorPolicyId: policyId,
        senderAuthority: "peer",
      }),
    ).not.toThrow();
    expect((): void =>
      validateMessageProvenance({
        messageKind: "orchestration_request",
        orchestratorPolicyId: null,
        senderAuthority: "peer",
      }),
    ).toThrow();
    expect((): void =>
      validateMessageProvenance({
        messageKind: "message",
        orchestratorPolicyId: policyId,
        senderAuthority: "peer",
      }),
    ).toThrow();
    expect((): void =>
      validateMessageProvenance({
        messageKind: "orchestration_request",
        orchestratorPolicyId: policyId,
        senderAuthority: "orchestrator",
      }),
    ).toThrow();
    expect(
      CreateTokenInputSchema.safeParse({ name: "self claim", role: "orchestrator" }).success,
    ).toBe(false);
  });
});
