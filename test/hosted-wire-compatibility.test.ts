import { expect, test } from "bun:test";
import { z } from "zod";

import { OrchestratorPolicyId, PersonalId } from "../src/domain/orchestration.js";
import { AgentId, Instant, MachineName, TenantId } from "../src/domain/value-objects.js";
import {
  type IssuedTokenDto,
  IssuedTokenDtoSchema,
  type TokenSummaryDto,
  TokenSummaryDtoSchema,
  toIssuedTokenDto,
  toTokenSummaryDto,
} from "../src/hosted/contracts.js";
import type { IssuedToken, TokenSummary } from "../src/hosted/control-plane-contracts.js";
import {
  type EffectiveOrchestratorDto,
  EffectiveOrchestratorDtoSchema,
  toEffectiveOrchestratorDto,
} from "../src/hosted/orchestration-contracts.js";

const TOKEN_ID: string = "10000000-0000-4000-8000-000000000001";
const INSTANT: Instant = Instant.parse("2026-09-07T00:00:00.000Z");
const oldIssuedSchema: z.ZodType<unknown> = z.strictObject({
  agent_id: z.unknown(),
  expires_at: z.unknown(),
  key_id: z.unknown(),
  name: z.unknown(),
  personal_id: z.unknown(),
  repository: z.unknown(),
  role: z.unknown(),
  secret: z.unknown(),
  tenant_id: z.unknown(),
  token_id: z.unknown(),
});
const oldSummarySchema: z.ZodType<unknown> = z.strictObject({
  agent_id: z.unknown(),
  created_at: z.unknown(),
  expires_at: z.unknown(),
  key_id: z.unknown(),
  last_used_at: z.unknown(),
  name: z.unknown(),
  personal_id: z.unknown(),
  repository: z.unknown(),
  revoked_at: z.unknown(),
  role: z.unknown(),
  token_id: z.unknown(),
});
const oldEffectiveSchema: z.ZodType<unknown> = z.strictObject({
  agent_id: z.unknown(),
  policy_id: z.unknown(),
  scope: z.strictObject({
    personal_id: z.unknown(),
    repository: z.unknown(),
    scope_kind: z.unknown(),
  }),
});

function issued(machineName: MachineName | null): IssuedToken {
  return {
    agentId: null,
    expiresAt: null,
    keyId: "worker01",
    machineName,
    name: "Compatibility worker",
    personalId: PersonalId.parse(TOKEN_ID),
    repositoryName: null,
    role: "agent",
    secret: `mur_worker01_${"a".repeat(43)}`,
    tenantId: TenantId.parse("20000000-0000-4000-8000-000000000001"),
    tokenId: TOKEN_ID,
  };
}

test("legacy token readers accept global outputs and upgraded readers accept old persisted files", (): void => {
  const globalIssued: IssuedTokenDto = toIssuedTokenDto(issued(null));
  expect(oldIssuedSchema.safeParse(globalIssued).success).toBe(true);
  expect(IssuedTokenDtoSchema.safeParse(globalIssued).success).toBe(true);
  const summary: TokenSummary = {
    ...issued(null),
    createdAt: INSTANT,
    lastUsedAt: null,
    revokedAt: null,
  };
  const globalSummary: TokenSummaryDto = toTokenSummaryDto(summary);
  expect(oldSummarySchema.safeParse(globalSummary).success).toBe(true);
  expect(TokenSummaryDtoSchema.safeParse(globalSummary).success).toBe(true);
  expect(toIssuedTokenDto(issued(MachineName.parse("build-1")))).toHaveProperty(
    "machine",
    "build-1",
  );
});

test("legacy orchestrator readers accept global resolution while upgraded readers accept old routes", (): void => {
  const effective: EffectiveOrchestratorDto = toEffectiveOrchestratorDto({
    orchestratorAgentId: AgentId.parse("compatibility-orchestrator"),
    policyId: OrchestratorPolicyId.parse("30000000-0000-4000-8000-000000000001"),
    scope: {
      kind: "organization",
      machineName: null,
      personalId: null,
      repositoryName: null,
    },
  });
  expect(oldEffectiveSchema.safeParse(effective).success).toBe(true);
  expect(EffectiveOrchestratorDtoSchema.safeParse(effective).success).toBe(true);
});
