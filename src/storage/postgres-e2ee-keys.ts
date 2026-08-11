import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { SessionKey } from "../domain/lifecycle-values.js";
import type { Agent } from "../domain/models.js";
import { AgentId, type Instant, type TenantId } from "../domain/value-objects.js";
import type {
  AgentKeyRevocationDto,
  PrekeyCertificateDto,
  PublicAgentKeyBundleDto,
} from "../e2ee/wire-contracts.js";
import {
  PrekeyCertificateDtoSchema,
  PublicAgentKeyBundleDtoSchema,
} from "../e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type PublishAgentKeyBundleInput,
  type PublishAgentKeyBundleOutput,
  PublishAgentKeyBundleOutputSchema,
} from "../e2ee/wire-tools.js";
import type { E2eeOrchestrationScope, E2eeWriteAuthorization } from "./e2ee-message-store.js";
import { claimablePublicBundle } from "./e2ee-store-validation.js";
import { renewPostgresSessionInTransaction } from "./postgres-agent-lifecycle-store.js";
import {
  type PostgresE2eeBundleRow,
  PostgresE2eeBundleRowSchema,
  type PostgresE2eePrekeyRow,
  PostgresE2eePrekeyRowSchema,
} from "./postgres-e2ee-rows.js";
import { requirePostgresE2eeWriteState } from "./postgres-e2ee-state.js";
import { updatePostgresE2eeUsage } from "./postgres-e2ee-usage.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";

const CLAIM_MINUTES: number = 5;

function parseBundleRows(input: unknown): PostgresE2eeBundleRow[] {
  const parsed: z.ZodSafeParseResult<PostgresE2eeBundleRow[]> = z
    .array(PostgresE2eeBundleRowSchema)
    .safeParse(input);
  if (!parsed.success) throw new Error("Stored PostgreSQL E2E key bundle is invalid");
  return parsed.data;
}

function parsePrekeyRows(input: unknown): PostgresE2eePrekeyRow[] {
  const parsed: z.ZodSafeParseResult<PostgresE2eePrekeyRow[]> = z
    .array(PostgresE2eePrekeyRowSchema)
    .safeParse(input);
  if (!parsed.success) throw new Error("Stored PostgreSQL E2E prekey is invalid");
  return parsed.data;
}

function revocations(bundle: PublicAgentKeyBundleDto): readonly AgentKeyRevocationDto[] {
  return bundle.agent_key_revocations === undefined ? [] : bundle.agent_key_revocations;
}

function requireMonotonicIdentity(
  previous: PublicAgentKeyBundleDto,
  next: PublicAgentKeyBundleDto,
): void {
  if (previous.root_key_id !== next.root_key_id) {
    throw new Error("Published E2E root key cannot change");
  }
  const nextByKey: ReadonlyMap<string, AgentKeyRevocationDto> = new Map<
    string,
    AgentKeyRevocationDto
  >(
    revocations(next).map(
      (item: AgentKeyRevocationDto): readonly [string, AgentKeyRevocationDto] => [
        item.revoked_signing_key_id,
        item,
      ],
    ),
  );
  for (const prior of revocations(previous)) {
    const current: AgentKeyRevocationDto | undefined = nextByKey.get(prior.revoked_signing_key_id);
    if (current === undefined || !isDeepStrictEqual(current, prior)) {
      throw new Error("Published E2E agent revocations cannot be removed or changed");
    }
  }
}

function publicationOutput(
  input: PublishAgentKeyBundleInput,
  publishedAt: string,
): PublishAgentKeyBundleOutput {
  return PublishAgentKeyBundleOutputSchema.parse({
    agent_id: input.agent_id,
    fallback_prekey_id: input.bundle.fallback_prekey.prekey_id,
    one_time_prekey_count: input.bundle.one_time_prekeys.length,
    published_at: publishedAt,
    root_key_id: input.bundle.root_key_id,
  });
}

export async function publishPostgresAgentKeyBundle(
  database: Sql,
  tenantId: TenantId,
  input: PublishAgentKeyBundleInput,
  now: Instant,
): Promise<PublishAgentKeyBundleOutput> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<PublishAgentKeyBundleOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      await requirePostgresE2eeWriteState(transaction, tenantId, ["provisioning", "enforced"]);
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [input.agent_id]);
      const agent: Agent = await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        AgentId.parse(input.agent_id),
        input.session_key === undefined
          ? SessionKey.default()
          : SessionKey.parse(input.session_key),
        now,
        true,
      );
      const rawExisting: unknown = await transaction`
        SELECT agent_generation, bundle_json::text AS bundle_json,
          to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at
        FROM murmur.e2ee_key_bundles
        WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${input.agent_id}
        FOR UPDATE
      `;
      const existingRows: PostgresE2eeBundleRow[] = parseBundleRows(rawExisting);
      const existing: PostgresE2eeBundleRow | undefined = existingRows[0];
      const previousBundle: PublicAgentKeyBundleDto | null =
        existing === undefined
          ? null
          : PublicAgentKeyBundleDtoSchema.parse(JSON.parse(existing.bundle_json));
      if (
        existing !== undefined &&
        previousBundle !== null &&
        existing.agent_generation === agent.generation.value &&
        isDeepStrictEqual(previousBundle, input.bundle)
      ) {
        return publicationOutput(input, existing.published_at);
      }
      if (previousBundle !== null) requireMonotonicIdentity(previousBundle, input.bundle);
      const countRaw: unknown = await transaction`
        SELECT pg_catalog.count(*)::integer AS count
        FROM murmur.e2ee_prekeys
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${input.agent_id}
          AND retired_at IS NULL AND claimed_at IS NULL
          AND expires_at > ${now.toISOString()}::timestamptz
      `;
      const countRows: { readonly count: number }[] = z
        .array(z.strictObject({ count: z.number().int().nonnegative() }))
        .parse(countRaw);
      const priorCount: number = countRows[0] === undefined ? 0 : countRows[0].count;
      await transaction`
        UPDATE murmur.e2ee_prekeys SET retired_at = ${now.toISOString()}::timestamptz
        WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${input.agent_id}
          AND retired_at IS NULL AND claimed_at IS NULL
      `;
      await transaction`
        INSERT INTO murmur.e2ee_key_bundles(
          tenant_id, agent_id, agent_generation, root_key_id, agent_key_id,
          bundle_json, published_at
        ) VALUES (
          ${tenantId.value}::uuid, ${input.agent_id}, ${agent.generation.value},
          ${input.bundle.root_key_id}, ${input.bundle.agent_certificate.signing_key_id},
          ${database.json(input.bundle)}, ${now.toISOString()}::timestamptz
        )
        ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
          agent_generation = excluded.agent_generation,
          root_key_id = excluded.root_key_id,
          agent_key_id = excluded.agent_key_id,
          bundle_json = excluded.bundle_json,
          published_at = excluded.published_at
      `;
      const prekeys: readonly PrekeyCertificateDto[] = [
        input.bundle.fallback_prekey,
        ...input.bundle.one_time_prekeys,
      ];
      for (const prekey of prekeys) {
        const rawPublished: unknown = await transaction`
          INSERT INTO murmur.e2ee_prekeys(
            tenant_id, prekey_id, agent_id, agent_generation, prekey_class,
            certificate_json, published_at, expires_at
          ) VALUES (
            ${tenantId.value}::uuid, ${prekey.prekey_id}, ${input.agent_id},
            ${agent.generation.value}, ${prekey.prekey_class}, ${database.json(prekey)},
            ${now.toISOString()}::timestamptz, ${prekey.expires_at}::timestamptz
          )
          ON CONFLICT(tenant_id, prekey_id) DO UPDATE SET
            agent_id = excluded.agent_id,
            agent_generation = excluded.agent_generation,
            published_at = excluded.published_at,
            expires_at = excluded.expires_at,
            retired_at = NULL
          WHERE murmur.e2ee_prekeys.certificate_json = excluded.certificate_json
            AND murmur.e2ee_prekeys.prekey_class = excluded.prekey_class
            AND murmur.e2ee_prekeys.claimed_at IS NULL
          RETURNING prekey_id
        `;
        const published: { readonly prekey_id: string }[] = z
          .array(z.strictObject({ prekey_id: z.string() }))
          .parse(rawPublished);
        if (published.length !== 1) {
          throw new Error("Published E2E prekey identifier was already retired or changed");
        }
      }
      await updatePostgresE2eeUsage(transaction, tenantId, {
        claimCount: 0,
        pendingBroadcastCount: 0,
        pendingCiphertextBytes: 0,
        pendingDeliveryCount: 0,
        publicPrekeyCount: prekeys.length - priorCount,
        retainedCiphertextBytes: 0,
        retainedMessageCount: 0,
      });
      return publicationOutput(input, now.toISOString());
    },
  );
}

export async function requireEffectivePostgresOrchestratorClaim(
  transaction: TransactionSql,
  tenantId: TenantId,
  input: ClaimEncryptionPrekeyInput,
  authorization: E2eeWriteAuthorization,
  policyId: string | null,
  expectedTokenId: string | null,
): Promise<string> {
  const scope: E2eeOrchestrationScope | null = authorization.orchestrationScope;
  if (scope === null || policyId === null) {
    throw new Error("Encrypted orchestrator authority is unavailable");
  }
  const raw: unknown = await transaction`
    SELECT policy.policy_id::text AS policy_id, token.token_id::text AS token_id
    FROM murmur.orchestrator_policies AS policy
    JOIN murmur.access_tokens AS token
      ON token.tenant_id = policy.tenant_id AND token.token_id = policy.orchestrator_token_id
    WHERE policy.tenant_id = ${tenantId.value}::uuid
      AND policy.enabled
      AND token.token_role = 'orchestrator'
      AND token.orchestrator_agent_id = ${input.recipient_id}
      AND token.revoked_at IS NULL
      AND (token.expires_at IS NULL OR token.expires_at > pg_catalog.statement_timestamp())
      AND (
        (policy.scope_kind = 'personal' AND policy.scope_owner_id = ${scope.personalId}::uuid)
        OR (policy.scope_kind = 'organization' AND policy.scope_owner_id = ${tenantId.value}::uuid)
      )
      AND (
        policy.repository_name = ''
        OR (${scope.repositoryName}::text IS NOT NULL AND policy.repository_name = ${scope.repositoryName})
      )
    ORDER BY
      CASE
        WHEN policy.scope_kind = 'personal' AND policy.repository_name <> '' THEN 1
        WHEN policy.scope_kind = 'organization' AND policy.repository_name <> '' THEN 2
        WHEN policy.scope_kind = 'personal' THEN 3
        ELSE 4
      END,
      policy.policy_id
    LIMIT 1
    FOR SHARE OF policy, token
  `;
  const rows: { readonly policy_id: string; readonly token_id: string }[] = z
    .array(z.strictObject({ policy_id: z.string().uuid(), token_id: z.string().uuid() }))
    .parse(raw);
  const effective: { readonly policy_id: string; readonly token_id: string } | undefined = rows[0];
  if (
    effective === undefined ||
    effective.policy_id !== policyId ||
    (expectedTokenId !== null && effective.token_id !== expectedTokenId)
  ) {
    throw new Error("Effective orchestrator changed before encryption claim commit");
  }
  return effective.token_id;
}

export async function claimPostgresEncryptionPrekey(
  database: Sql,
  tenantId: TenantId,
  input: ClaimEncryptionPrekeyInput,
  authorization: E2eeWriteAuthorization,
  now: Instant,
  broadcastId: string | null,
): Promise<ClaimEncryptionPrekeyOutput> {
  return await database.begin(
    async (transaction: TransactionSql): Promise<ClaimEncryptionPrekeyOutput> => {
      await setPostgresTenantContext(transaction, tenantId);
      return await claimPostgresEncryptionPrekeyInTransaction(
        database,
        transaction,
        tenantId,
        input,
        authorization,
        now,
        broadcastId,
      );
    },
  );
}

export async function claimPostgresEncryptionPrekeyInTransaction(
  database: Sql,
  transaction: TransactionSql,
  tenantId: TenantId,
  input: ClaimEncryptionPrekeyInput,
  authorization: E2eeWriteAuthorization,
  now: Instant,
  broadcastId: string | null,
  agentLocksHeld: boolean = false,
): Promise<ClaimEncryptionPrekeyOutput> {
  await requirePostgresE2eeWriteState(transaction, tenantId, ["enforced"]);
  if (authorization.boundSenderId !== null && authorization.boundSenderId !== input.sender_id) {
    throw new Error("Encrypted sender authority is unavailable for this credential");
  }
  if (!agentLocksHeld) {
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      input.recipient_id,
      input.sender_id,
    ]);
  }
  const orchestratorTokenId: string | null =
    authorization.provenance.message_kind === "orchestration_request"
      ? await requireEffectivePostgresOrchestratorClaim(
          transaction,
          tenantId,
          input,
          authorization,
          authorization.provenance.orchestrator_policy_id,
          null,
        )
      : null;
  const sessionKey: SessionKey =
    input.session_key === undefined ? SessionKey.default() : SessionKey.parse(input.session_key);
  const sender: Agent = await renewPostgresSessionInTransaction(
    transaction,
    tenantId,
    AgentId.parse(input.sender_id),
    sessionKey,
    now,
    true,
  );
  const recipient: Agent = await renewPostgresSessionInTransaction(
    transaction,
    tenantId,
    AgentId.parse(input.recipient_id),
    SessionKey.default(),
    now,
    false,
  );
  if (recipient.state !== "active") throw new Error("Encryption recipient is not active");
  const bundleRaw: unknown = await transaction`
        SELECT agent_generation, bundle_json::text AS bundle_json,
          to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at
        FROM murmur.e2ee_key_bundles
        WHERE tenant_id = ${tenantId.value}::uuid AND agent_id = ${input.recipient_id}
        FOR SHARE
      `;
  const bundles: PostgresE2eeBundleRow[] = parseBundleRows(bundleRaw);
  const storedBundle: PostgresE2eeBundleRow | undefined = bundles[0];
  if (storedBundle === undefined || storedBundle.agent_generation !== recipient.generation.value) {
    throw new Error("Encryption recipient has no current public key bundle");
  }
  const bundle: PublicAgentKeyBundleDto = claimablePublicBundle(
    JSON.parse(storedBundle.bundle_json),
    now.toISOString(),
  );
  const prekeyRaw: unknown = await transaction`
        SELECT prekey_id, prekey_class, certificate_json::text AS certificate_json
        FROM murmur.e2ee_prekeys
        WHERE tenant_id = ${tenantId.value}::uuid
          AND agent_id = ${input.recipient_id}
          AND agent_generation = ${recipient.generation.value}
          AND retired_at IS NULL AND claimed_at IS NULL
          AND expires_at > ${now.toISOString()}::timestamptz
        ORDER BY CASE WHEN prekey_class = 'one_time' THEN 0 ELSE 1 END, prekey_id
        LIMIT 1
        FOR UPDATE
      `;
  const prekeys: PostgresE2eePrekeyRow[] = parsePrekeyRows(prekeyRaw);
  const prekey: PostgresE2eePrekeyRow | undefined = prekeys[0];
  if (prekey === undefined) throw new Error("Encryption recipient has no available prekey");
  let certificate: PrekeyCertificateDto;
  if (prekey.prekey_class === "fallback" && bundle.fallback_prekey.prekey_id === prekey.prekey_id) {
    certificate = bundle.fallback_prekey;
  } else {
    const candidate: PrekeyCertificateDto | undefined = bundle.one_time_prekeys.find(
      (item: PrekeyCertificateDto): boolean => item.prekey_id === prekey.prekey_id,
    );
    if (prekey.prekey_class !== "one_time" || candidate === undefined) {
      throw new Error("Stored E2E prekey is absent from its bundle");
    }
    certificate = candidate;
  }
  const storedCertificate: PrekeyCertificateDto = PrekeyCertificateDtoSchema.parse(
    JSON.parse(prekey.certificate_json),
  );
  if (!isDeepStrictEqual(certificate, storedCertificate)) {
    throw new Error("Stored E2E prekey is absent from its bundle");
  }
  if (prekey.prekey_class === "one_time") {
    await transaction`
          UPDATE murmur.e2ee_prekeys SET claimed_at = ${now.toISOString()}::timestamptz
          WHERE tenant_id = ${tenantId.value}::uuid AND prekey_id = ${prekey.prekey_id}
        `;
  }
  const claimId: string = randomUUID();
  const expiresAtMs: number = Math.min(
    now.addMinutes(CLAIM_MINUTES).toEpochMilliseconds(),
    Date.parse(bundle.agent_certificate.expires_at),
    Date.parse(certificate.expires_at),
  );
  if (expiresAtMs <= now.toEpochMilliseconds()) {
    throw new Error("Encryption recipient has no currently valid E2E prekey");
  }
  const expiresAt: string = new Date(expiresAtMs).toISOString();
  const parsedOutput: z.ZodSafeParseResult<ClaimEncryptionPrekeyOutput> =
    ClaimEncryptionPrekeyOutputSchema.safeParse({
      bundle,
      claim_id: claimId,
      claimed_at: now.toISOString(),
      expires_at: expiresAt,
      prekey_class: prekey.prekey_class,
      prekey_id: prekey.prekey_id,
      provenance: authorization.provenance,
      recipient_id: input.recipient_id,
    });
  if (!parsedOutput.success) throw new Error("Generated PostgreSQL E2E claim is invalid");
  const output: ClaimEncryptionPrekeyOutput = parsedOutput.data;
  const storedRequest: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse({
    context: input.context,
    recipient_id: input.recipient_id,
    sender_id: input.sender_id,
  });
  await transaction`
        INSERT INTO murmur.e2ee_claims(
          tenant_id, claim_id, sender_id, sender_generation, recipient_id,
          recipient_generation, prekey_id, message_kind, sender_authority,
          orchestrator_policy_id, orchestrator_token_id, request_json, claim_json, broadcast_id,
          created_at, expires_at
        ) VALUES (
          ${tenantId.value}::uuid, ${claimId}::uuid, ${input.sender_id},
          ${sender.generation.value}, ${input.recipient_id}, ${recipient.generation.value},
          ${prekey.prekey_id}, ${authorization.provenance.message_kind},
          ${authorization.provenance.sender_authority},
          ${authorization.provenance.orchestrator_policy_id}::uuid,
          ${orchestratorTokenId}::uuid,
          ${database.json(storedRequest)}, ${database.json(output)}, ${broadcastId}::uuid,
          ${now.toISOString()}::timestamptz, ${expiresAt}::timestamptz
        )
      `;
  await updatePostgresE2eeUsage(transaction, tenantId, {
    claimCount: 1,
    pendingBroadcastCount: 0,
    pendingCiphertextBytes: 0,
    pendingDeliveryCount: 0,
    publicPrekeyCount: prekey.prekey_class === "one_time" ? -1 : 0,
    retainedCiphertextBytes: 0,
    retainedMessageCount: 0,
  });
  return output;
}
