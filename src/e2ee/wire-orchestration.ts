import { z } from "zod";

import { SessionKeyInputSchema } from "../domain/lifecycle-values.js";
import {
  type EffectiveOrchestratorDto,
  EffectiveOrchestratorDtoSchema,
} from "../hosted/orchestration-contracts.js";
import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type E2eeMessageContextDto,
  E2eeMessageContextDtoSchema,
} from "./wire-tools.js";

const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export type ClaimOrchestratorPrekeyInput = {
  readonly context: E2eeMessageContextDto;
  readonly sender_id: string;
  readonly session_key?: string | undefined;
};

export type ClaimOrchestratorPrekeyOutput = {
  readonly claim: ClaimEncryptionPrekeyOutput;
  readonly orchestrator: EffectiveOrchestratorDto;
};

export const ClaimOrchestratorPrekeyInputSchema: z.ZodType<ClaimOrchestratorPrekeyInput> =
  z.strictObject({
    context: E2eeMessageContextDtoSchema,
    sender_id: AgentIdSchema,
    session_key: SessionKeyInputSchema.optional(),
  });

export const ClaimOrchestratorPrekeyOutputSchema: z.ZodType<ClaimOrchestratorPrekeyOutput> =
  z.strictObject({
    claim: ClaimEncryptionPrekeyOutputSchema,
    orchestrator: EffectiveOrchestratorDtoSchema,
  });
