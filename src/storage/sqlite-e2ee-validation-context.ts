import type { Database } from "bun:sqlite";

import {
  type PublicAgentKeyBundleDto,
  PublicAgentKeyBundleDtoSchema,
  type PublicAgentSigningChainDto,
} from "../e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
} from "../e2ee/wire-tools.js";
import { senderChainFromBundle } from "./e2ee-store-validation.js";
import { type SqliteE2eeClaimRow, SqliteE2eeClaimRowSchema } from "./sqlite-e2ee-rows.js";

export type SqliteHostedEnvelopeValidationContext = {
  readonly claimInput: ClaimEncryptionPrekeyInput;
  readonly claimOutput: ClaimEncryptionPrekeyOutput;
  readonly senderChain: PublicAgentSigningChainDto;
};

export function sqliteHostedEnvelopeValidationContext(
  database: Database,
  claimId: string,
): SqliteHostedEnvelopeValidationContext {
  const row: SqliteE2eeClaimRow = SqliteE2eeClaimRowSchema.parse(
    database
      .query<unknown, [string]>(`
        SELECT broadcast_id, claim_json, consumed_at, expires_at,
          recipient_generation, request_json, sender_generation
        FROM e2ee_claims WHERE claim_id = ?
      `)
      .get(claimId),
  );
  const claimInput: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse(
    JSON.parse(row.request_json),
  );
  const claimOutput: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
    JSON.parse(row.claim_json),
  );
  const rawBundle: unknown = database
    .query<unknown, [string, number]>(`
      SELECT bundle_json FROM e2ee_key_bundles
      WHERE agent_id = ? AND agent_generation = ?
    `)
    .get(claimInput.sender_id, row.sender_generation);
  if (rawBundle === null || typeof rawBundle !== "object") {
    throw new Error("Sender has no current E2E signing bundle");
  }
  const bundleJson: unknown = Reflect.get(rawBundle, "bundle_json");
  if (typeof bundleJson !== "string") throw new Error("Stored E2E sender bundle is invalid");
  const bundle: PublicAgentKeyBundleDto = PublicAgentKeyBundleDtoSchema.parse(
    JSON.parse(bundleJson),
  );
  return { claimInput, claimOutput, senderChain: senderChainFromBundle(bundle) };
}
