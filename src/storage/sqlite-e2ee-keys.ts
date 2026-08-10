import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { UnknownAgentError } from "../domain/errors.js";
import type { Instant } from "../domain/value-objects.js";
import type { PrekeyCertificateDto, PublicAgentKeyBundleDto } from "../e2ee/wire-contracts.js";
import { PublicAgentKeyBundleDtoSchema } from "../e2ee/wire-contracts.js";
import {
  type ClaimedProvenanceDto,
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type PublishAgentKeyBundleInput,
  PublishAgentKeyBundleInputSchema,
  type PublishAgentKeyBundleOutput,
  PublishAgentKeyBundleOutputSchema,
} from "../e2ee/wire-tools.js";
import {
  type SqliteE2eeAgentRow,
  SqliteE2eeAgentRowSchema,
  type SqliteE2eeBundleRow,
  SqliteE2eeBundleRowSchema,
  SqliteE2eeCountRowSchema,
} from "./sqlite-e2ee-rows.js";
import { updateSqliteE2eeUsage } from "./sqlite-e2ee-usage.js";

const CLAIM_MINUTES: number = 5;
const PEER_PROVENANCE: ClaimedProvenanceDto = {
  message_kind: "message",
  orchestrator_policy_id: null,
  sender_authority: "peer",
};

type PrekeyRow = {
  readonly certificate_json: string;
  readonly claimed_at: string | null;
  readonly prekey_class: "fallback" | "one_time";
};

const PrekeyRowSchema: z.ZodType<PrekeyRow> = z.strictObject({
  certificate_json: z.string(),
  claimed_at: z.string().nullable(),
  prekey_class: z.enum(["fallback", "one_time"]),
});

function activeAgent(database: Database, agentId: string, now: Instant): SqliteE2eeAgentRow {
  const raw: unknown = database
    .query<unknown, [string, string]>(`
      SELECT agent.agent_id, agent.generation
      FROM agents AS agent
      WHERE agent.agent_id = ?
        AND agent.closed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM agent_sessions AS session
          WHERE session.agent_id = agent.agent_id
            AND session.generation = agent.generation
            AND session.ended_at IS NULL
            AND session.lease_expires_at > ?
        )
    `)
    .get(agentId, now.toISOString());
  if (raw === null) throw new UnknownAgentError(agentId);
  return SqliteE2eeAgentRowSchema.parse(raw);
}

function validateBundleWindow(bundle: PublicAgentKeyBundleDto, now: Instant): void {
  const nowMs: number = now.toEpochMilliseconds();
  const certificates: readonly { readonly created_at: string; readonly expires_at: string }[] = [
    bundle.agent_certificate,
    bundle.fallback_prekey,
    ...bundle.one_time_prekeys,
  ];
  for (const certificate of certificates) {
    const createdAt: number = Date.parse(certificate.created_at);
    const expiresAt: number = Date.parse(certificate.expires_at);
    if (createdAt > nowMs || expiresAt <= nowMs) {
      throw new Error("Published E2E certificate window is not currently valid");
    }
  }
}

function activePrekeyCount(database: Database, agentId: string): number {
  const row: { readonly count: number } = SqliteE2eeCountRowSchema.parse(
    database
      .query<unknown, [string]>(`
        SELECT COUNT(*) AS count FROM e2ee_prekeys
        WHERE agent_id = ? AND retired_at IS NULL AND claimed_at IS NULL
      `)
      .get(agentId),
  );
  return row.count;
}

function publishPrekey(
  database: Database,
  agent: SqliteE2eeAgentRow,
  prekey: PrekeyCertificateDto,
  now: Instant,
): void {
  const serialized: string = JSON.stringify(prekey);
  const existingRaw: unknown = database
    .query<unknown, [string]>(`
      SELECT certificate_json, claimed_at, prekey_class
      FROM e2ee_prekeys WHERE prekey_id = ?
    `)
    .get(prekey.prekey_id);
  if (existingRaw !== null) {
    const existing: PrekeyRow = PrekeyRowSchema.parse(existingRaw);
    if (
      existing.certificate_json !== serialized ||
      existing.prekey_class !== prekey.prekey_class ||
      existing.claimed_at !== null
    ) {
      throw new Error("Published E2E prekey identifier was already retired or changed");
    }
    database
      .query<unknown, [string, number, string, string]>(`
        UPDATE e2ee_prekeys SET
          agent_id = ?, agent_generation = ?, published_at = ?, retired_at = NULL
        WHERE prekey_id = ?
      `)
      .run(agent.agent_id, agent.generation, now.toISOString(), prekey.prekey_id);
    return;
  }
  database
    .query<unknown, [string, string, number, string, string, string]>(`
      INSERT INTO e2ee_prekeys(
        prekey_id, agent_id, agent_generation, prekey_class, certificate_json, published_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      prekey.prekey_id,
      agent.agent_id,
      agent.generation,
      prekey.prekey_class,
      serialized,
      now.toISOString(),
    );
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

export function publishSqliteAgentKeyBundle(
  database: Database,
  inputValue: unknown,
  now: Instant,
): PublishAgentKeyBundleOutput {
  const input: PublishAgentKeyBundleInput = PublishAgentKeyBundleInputSchema.parse(inputValue);
  validateBundleWindow(input.bundle, now);
  database.exec("BEGIN IMMEDIATE");
  try {
    const agent: SqliteE2eeAgentRow = activeAgent(database, input.agent_id, now);
    const bundleJson: string = JSON.stringify(input.bundle);
    const existingRaw: unknown = database
      .query<unknown, [string]>(`
        SELECT agent_generation, bundle_json, published_at
        FROM e2ee_key_bundles WHERE agent_id = ?
      `)
      .get(input.agent_id);
    if (existingRaw !== null) {
      const existing: SqliteE2eeBundleRow = SqliteE2eeBundleRowSchema.parse(existingRaw);
      if (existing.agent_generation === agent.generation && existing.bundle_json === bundleJson) {
        database.exec("COMMIT");
        return publicationOutput(input, existing.published_at);
      }
    }
    const priorCount: number = activePrekeyCount(database, input.agent_id);
    database
      .query<unknown, [string, string]>(`
        UPDATE e2ee_prekeys SET retired_at = ?
        WHERE agent_id = ? AND retired_at IS NULL AND claimed_at IS NULL
      `)
      .run(now.toISOString(), input.agent_id);
    const prekeys: readonly PrekeyCertificateDto[] = [
      input.bundle.fallback_prekey,
      ...input.bundle.one_time_prekeys,
    ];
    for (const prekey of prekeys) publishPrekey(database, agent, prekey, now);
    database
      .query<unknown, [string, number, string, string, string, string]>(`
        INSERT INTO e2ee_key_bundles(
          agent_id, agent_generation, root_key_id, agent_key_id, bundle_json, published_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          agent_generation = excluded.agent_generation,
          root_key_id = excluded.root_key_id,
          agent_key_id = excluded.agent_key_id,
          bundle_json = excluded.bundle_json,
          published_at = excluded.published_at
      `)
      .run(
        input.agent_id,
        agent.generation,
        input.bundle.root_key_id,
        input.bundle.agent_certificate.signing_key_id,
        bundleJson,
        now.toISOString(),
      );
    updateSqliteE2eeUsage(database, {
      claimCount: 0,
      pendingBroadcastCount: 0,
      pendingCiphertextBytes: 0,
      pendingDeliveryCount: 0,
      publicPrekeyCount: prekeys.length - priorCount,
      retainedCiphertextBytes: 0,
      retainedMessageCount: 0,
    });
    database.exec("COMMIT");
    return publicationOutput(input, now.toISOString());
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function currentBundle(database: Database, recipient: SqliteE2eeAgentRow): PublicAgentKeyBundleDto {
  const raw: unknown = database
    .query<unknown, [string, number]>(`
      SELECT bundle_json FROM e2ee_key_bundles
      WHERE agent_id = ? AND agent_generation = ?
    `)
    .get(recipient.agent_id, recipient.generation);
  if (raw === null || typeof raw !== "object") {
    throw new Error("Recipient has no published E2E key bundle");
  }
  const bundleJson: unknown = Reflect.get(raw, "bundle_json");
  if (typeof bundleJson !== "string") throw new Error("Stored E2E key bundle is invalid");
  return PublicAgentKeyBundleDtoSchema.parse(JSON.parse(bundleJson));
}

function selectedPrekey(
  database: Database,
  recipient: SqliteE2eeAgentRow,
  bundle: PublicAgentKeyBundleDto,
): PrekeyCertificateDto {
  const raw: unknown = database
    .query<unknown, [string, number]>(`
      SELECT certificate_json FROM e2ee_prekeys
      WHERE agent_id = ? AND agent_generation = ? AND prekey_class = 'one_time'
        AND claimed_at IS NULL AND retired_at IS NULL
      ORDER BY prekey_id ASC LIMIT 1
    `)
    .get(recipient.agent_id, recipient.generation);
  if (raw === null) return bundle.fallback_prekey;
  if (typeof raw !== "object") throw new Error("Stored E2E prekey is invalid");
  const certificateJson: unknown = Reflect.get(raw, "certificate_json");
  if (typeof certificateJson !== "string") throw new Error("Stored E2E prekey is invalid");
  const parsed: unknown = JSON.parse(certificateJson);
  const match: PrekeyCertificateDto | undefined = bundle.one_time_prekeys.find(
    (candidate: PrekeyCertificateDto): boolean =>
      candidate.prekey_id ===
      (typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "prekey_id") : null),
  );
  if (match === undefined) throw new Error("Stored E2E prekey is absent from its bundle");
  return match;
}

export function claimSqliteEncryptionPrekeyInTransaction(
  database: Database,
  inputValue: unknown,
  now: Instant,
  broadcastId: string | null,
  provenance: ClaimedProvenanceDto = PEER_PROVENANCE,
): ClaimEncryptionPrekeyOutput {
  const input: ClaimEncryptionPrekeyInput = ClaimEncryptionPrekeyInputSchema.parse(inputValue);
  const sender: SqliteE2eeAgentRow = activeAgent(database, input.sender_id, now);
  const recipient: SqliteE2eeAgentRow = activeAgent(database, input.recipient_id, now);
  const bundle: PublicAgentKeyBundleDto = currentBundle(database, recipient);
  validateBundleWindow(bundle, now);
  const prekey: PrekeyCertificateDto = selectedPrekey(database, recipient, bundle);
  if (prekey.prekey_class === "one_time") {
    const changes: number = database
      .query<unknown, [string, string]>(`
        UPDATE e2ee_prekeys SET claimed_at = ?
        WHERE prekey_id = ? AND claimed_at IS NULL AND retired_at IS NULL
      `)
      .run(now.toISOString(), prekey.prekey_id).changes;
    if (changes !== 1) throw new Error("Encryption prekey was concurrently claimed");
  }
  const expiresAtMs: number = Math.min(
    now.addMinutes(CLAIM_MINUTES).toEpochMilliseconds(),
    Date.parse(bundle.agent_certificate.expires_at),
    Date.parse(prekey.expires_at),
  );
  if (expiresAtMs <= now.toEpochMilliseconds()) {
    throw new Error("Recipient has no currently valid E2E prekey");
  }
  const output: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse({
    bundle,
    claim_id: randomUUID(),
    claimed_at: now.toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    prekey_class: prekey.prekey_class,
    prekey_id: prekey.prekey_id,
    provenance,
    recipient_id: input.recipient_id,
  });
  database
    .query<
      unknown,
      [
        string,
        string,
        number,
        string,
        number,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ]
    >(`
      INSERT INTO e2ee_claims(
        claim_id, sender_id, sender_generation, recipient_id, recipient_generation,
        prekey_id, prekey_class, request_json, claim_json, broadcast_id, claimed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      output.claim_id,
      input.sender_id,
      sender.generation,
      input.recipient_id,
      recipient.generation,
      prekey.prekey_id,
      prekey.prekey_class,
      JSON.stringify(input),
      JSON.stringify(output),
      broadcastId,
      output.claimed_at,
      output.expires_at,
    );
  updateSqliteE2eeUsage(database, {
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

export function claimSqliteEncryptionPrekey(
  database: Database,
  inputValue: unknown,
  now: Instant,
): ClaimEncryptionPrekeyOutput {
  database.exec("BEGIN IMMEDIATE");
  try {
    const output: ClaimEncryptionPrekeyOutput = claimSqliteEncryptionPrekeyInTransaction(
      database,
      inputValue,
      now,
      null,
    );
    database.exec("COMMIT");
    return output;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
