import type { TransactionSql } from "postgres";
import { z } from "zod";

import type { TenantId } from "../domain/value-objects.js";
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
import { requireCurrentClaimRecipient, senderChainFromBundle } from "./e2ee-store-validation.js";
import { type PostgresE2eeClaimRow, PostgresE2eeClaimRowSchema } from "./postgres-e2ee-rows.js";

export type PostgresHostedEnvelopeValidationContext = {
  readonly claimInput: ClaimEncryptionPrekeyInput;
  readonly claimOutput: ClaimEncryptionPrekeyOutput;
  readonly row: PostgresE2eeClaimRow;
  readonly senderChain: PublicAgentSigningChainDto;
};

export async function postgresHostedEnvelopeValidationContext(
  transaction: TransactionSql,
  tenantId: TenantId,
  claimId: string,
): Promise<PostgresHostedEnvelopeValidationContext> {
  const rawClaim: unknown = await transaction`
    SELECT broadcast_id::text AS broadcast_id, claim_json::text AS claim_json,
      CASE WHEN consumed_at IS NULL THEN NULL ELSE
        to_char(consumed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS consumed_at,
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      orchestrator_token_id::text AS orchestrator_token_id,
      recipient_generation, request_json::text AS request_json, sender_generation
    FROM murmur.e2ee_claims
    WHERE tenant_id = ${tenantId.value}::uuid AND claim_id = ${claimId}::uuid
    FOR UPDATE
  `;
  const rows: PostgresE2eeClaimRow[] = z.array(PostgresE2eeClaimRowSchema).parse(rawClaim);
  const row: PostgresE2eeClaimRow | undefined = rows[0];
  if (row === undefined) throw new Error("Encryption claim is unavailable or expired");
  const claimInput: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse(
    JSON.parse(row.request_json),
  );
  const claimOutput: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
    JSON.parse(row.claim_json),
  );
  const rawRecipientBundle: unknown = await transaction`
    SELECT bundle_json::text AS bundle_json
    FROM murmur.e2ee_key_bundles
    WHERE tenant_id = ${tenantId.value}::uuid
      AND agent_id = ${claimInput.recipient_id}
      AND agent_generation = ${row.recipient_generation}
    FOR SHARE
  `;
  const recipientBundles: { readonly bundle_json: string }[] = z
    .array(z.strictObject({ bundle_json: z.string() }))
    .parse(rawRecipientBundle);
  const recipientBundle: { readonly bundle_json: string } | undefined = recipientBundles[0];
  if (recipientBundle === undefined) throw new Error("Recipient has no current E2E key bundle");
  requireCurrentClaimRecipient(claimOutput.bundle, JSON.parse(recipientBundle.bundle_json));
  const rawBundle: unknown = await transaction`
    SELECT bundle_json::text AS bundle_json
    FROM murmur.e2ee_key_bundles
    WHERE tenant_id = ${tenantId.value}::uuid
      AND agent_id = ${claimInput.sender_id}
      AND agent_generation = ${row.sender_generation}
    FOR SHARE
  `;
  const bundles: { readonly bundle_json: string }[] = z
    .array(z.strictObject({ bundle_json: z.string() }))
    .parse(rawBundle);
  const storedBundle: { readonly bundle_json: string } | undefined = bundles[0];
  if (storedBundle === undefined) throw new Error("Sender has no current E2E signing bundle");
  const bundle: PublicAgentKeyBundleDto = PublicAgentKeyBundleDtoSchema.parse(
    JSON.parse(storedBundle.bundle_json),
  );
  return { claimInput, claimOutput, row, senderChain: senderChainFromBundle(bundle) };
}
