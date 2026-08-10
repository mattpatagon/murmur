import { z } from "zod";

import type { AgentKeyRevocation } from "./certificates.js";

const Base64UrlSchema: z.ZodString = z
  .string()
  .min(1)
  .max(700_000)
  .regex(/^[A-Za-z0-9_-]+$/u);
const AgentIdSchema: z.ZodString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RootKeyIdSchema: z.ZodString = z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u);
const AgentKeyIdSchema: z.ZodString = z.string().regex(/^mak_[A-Za-z0-9_-]{43}$/u);
const InstantSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const SIGNATURE_BYTES: number = 64;

export type AgentKeyRevocationDto = {
  readonly agent_id: string;
  readonly reason: string;
  readonly revoked_at: string;
  readonly revoked_signing_key_id: string;
  readonly root_key_id: string;
  readonly signature: string;
};

export const AgentKeyRevocationDtoSchema: z.ZodType<AgentKeyRevocationDto> = z.strictObject({
  agent_id: AgentIdSchema,
  reason: z.string().min(1).max(500),
  revoked_at: InstantSchema,
  revoked_signing_key_id: AgentKeyIdSchema,
  root_key_id: RootKeyIdSchema,
  signature: Base64UrlSchema.length(86),
});

export function validateRevocationSet(
  revocations: readonly AgentKeyRevocationDto[],
  agentId: string,
  rootKeyId: string,
  currentSigningKeyId: string,
  context: z.core.$RefinementCtx,
): void {
  let previousKeyId: string | null = null;
  for (const revocation of revocations) {
    if (revocation.agent_id !== agentId || revocation.root_key_id !== rootKeyId) {
      context.addIssue({ code: "custom", message: "Agent revocation identity does not match" });
    }
    if (revocation.revoked_signing_key_id === currentSigningKeyId) {
      context.addIssue({ code: "custom", message: "Current agent signing key is revoked" });
    }
    if (previousKeyId !== null && revocation.revoked_signing_key_id <= previousKeyId) {
      context.addIssue({
        code: "custom",
        message: "Agent revocations must have unique sorted signing key identifiers",
      });
    }
    previousKeyId = revocation.revoked_signing_key_id;
  }
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeSignature(value: string): Uint8Array {
  const decoded: Uint8Array = Uint8Array.from(Buffer.from(value, "base64url"));
  if (decoded.byteLength !== SIGNATURE_BYTES || encodeBytes(decoded) !== value) {
    throw new Error("Agent revocation signature is not canonical base64url");
  }
  return decoded;
}

export function agentKeyRevocationToDto(revocation: AgentKeyRevocation): AgentKeyRevocationDto {
  return {
    agent_id: revocation.agentId,
    reason: revocation.reason,
    revoked_at: revocation.revokedAt,
    revoked_signing_key_id: revocation.revokedSigningKeyId,
    root_key_id: revocation.rootKeyId,
    signature: encodeBytes(revocation.signature),
  };
}

export function dtoToAgentKeyRevocation(dto: AgentKeyRevocationDto): AgentKeyRevocation {
  return {
    agentId: dto.agent_id,
    reason: dto.reason,
    revokedAt: dto.revoked_at,
    revokedSigningKeyId: dto.revoked_signing_key_id,
    rootKeyId: dto.root_key_id,
    signature: decodeSignature(dto.signature),
  };
}

export function revocationsFromDto(
  revocations: readonly AgentKeyRevocationDto[] | undefined,
): readonly AgentKeyRevocation[] {
  if (revocations === undefined) return [];
  return revocations.map(dtoToAgentKeyRevocation);
}
