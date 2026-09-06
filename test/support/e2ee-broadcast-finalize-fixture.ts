import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { Instant, TenantId } from "../../src/domain/value-objects.js";
import { E2EE_CIPHER_SUITE, E2EE_PADDING_SCHEME, E2EE_PROTOCOL } from "../../src/e2ee/protocol.js";
import {
  type EncryptedEnvelopeDto,
  EncryptedEnvelopeDtoSchema,
  type PublicAgentSigningChainDto,
  PublicAgentSigningChainDtoSchema,
} from "../../src/e2ee/wire-contracts.js";
import type { E2eeWriteAuthorization } from "../../src/storage/e2ee-message-store.js";
import { migrateSqliteDatabase } from "../../src/storage/sqlite-message-migrations.js";

export const FINALIZE_NOW: Instant = Instant.parse("2026-09-05T00:00:00.000Z");
export const FINALIZE_AUTHORIZATION: E2eeWriteAuthorization = {
  boundSenderId: "sender",
  orchestrationScope: null,
  provenance: {
    message_kind: "message",
    orchestrator_policy_id: null,
    sender_authority: "peer",
  },
};

export type FinalizeFixtureDelivery = {
  readonly claimId: string;
  readonly envelope: EncryptedEnvelopeDto;
  readonly recipientId: string;
};

export function finalizeSenderChain(identityPrefix: string = ""): PublicAgentSigningChainDto {
  return PublicAgentSigningChainDtoSchema.parse({
    agent_certificate: {
      agent_id: `${identityPrefix}sender`,
      created_at: FINALIZE_NOW.toISOString(),
      expires_at: FINALIZE_NOW.addDays(30).toISOString(),
      root_key_id: `mrk_${"a".repeat(43)}`,
      signature: "a".repeat(86),
      signing_key_id: `mak_${"b".repeat(43)}`,
      signing_public_key: "b".repeat(43),
    },
    root_key_id: `mrk_${"a".repeat(43)}`,
    root_public_key: "a".repeat(43),
  });
}

// These are already-staged DTOs, not cryptographic upload fixtures. Finalization validates
// stored structure and snapshot consistency; signature verification belongs to delivery upload.
export function finalizeFixtureDeliveries(
  broadcastId: string,
  count: number,
  tenantId: string = TenantId.founding().value,
  paddedLength: number = 512,
  firstIndex: number = 0,
  identityPrefix: string = "",
): readonly FinalizeFixtureDelivery[] {
  return Array.from(
    { length: count },
    (_unused: unknown, index: number): FinalizeFixtureDelivery => {
      const recipientId: string = `${identityPrefix}recipient-${String(index + firstIndex).padStart(3, "0")}`;
      return {
        claimId: randomUUID(),
        envelope: EncryptedEnvelopeDtoSchema.parse({
          ciphertext: Buffer.alloc(paddedLength + 16, 1).toString("base64url"),
          ephemeral_public_key: "a".repeat(43),
          header: {
            branch_name: null,
            broadcast_id: broadcastId,
            cipher_suite: E2EE_CIPHER_SUITE,
            client: "codex",
            created_at: FINALIZE_NOW.toISOString(),
            expires_at: FINALIZE_NOW.addDays(1).toISOString(),
            idempotency_key: `${broadcastId}-${index + firstIndex}`,
            message_id: randomUUID(),
            message_kind: "message",
            orchestrator_policy_id: null,
            padded_length: paddedLength,
            padding_scheme: E2EE_PADDING_SCHEME,
            pair_counter: 1,
            protocol: E2EE_PROTOCOL,
            recipient_agent_key_id: `mak_${"c".repeat(43)}`,
            recipient_id: recipientId,
            recipient_prekey_class: "fallback",
            recipient_prekey_id: `mpk_${"d".repeat(43)}`,
            recipient_root_key_id: `mrk_${"e".repeat(43)}`,
            repository_name: null,
            sender_agent_key_id: `mak_${"b".repeat(43)}`,
            sender_authority: "peer",
            sender_id: `${identityPrefix}sender`,
            sender_root_key_id: `mrk_${"a".repeat(43)}`,
            tenant_id: tenantId,
            thread_id: "finalize-memory",
          },
          nonce: "a".repeat(32),
          signature: "a".repeat(86),
        }),
        recipientId,
      };
    },
  );
}

export type SqliteFinalizeFixture = {
  readonly broadcastId: string;
  readonly database: Database;
  readonly deliveries: readonly FinalizeFixtureDelivery[];
};

export function withSqliteFinalizeFixture(
  count: number,
  run: (fixture: SqliteFinalizeFixture) => void,
): void {
  const database: Database = new Database(":memory:");
  try {
    migrateSqliteDatabase(database);
    const broadcastId: string = randomUUID();
    const deliveries: readonly FinalizeFixtureDelivery[] = finalizeFixtureDeliveries(
      broadcastId,
      count,
    );
    for (const agentId of [
      "sender",
      ...deliveries.map((delivery: FinalizeFixtureDelivery): string => delivery.recipientId),
    ]) {
      database
        .query(
          "INSERT INTO agents(agent_id, display_name, metadata_json, created_at, last_seen_at) VALUES (?, ?, '{}', ?, ?)",
        )
        .run(agentId, agentId, FINALIZE_NOW.toISOString(), FINALIZE_NOW.toISOString());
    }
    database
      .query(`INSERT INTO e2ee_broadcasts(
      broadcast_id, sender_id, sender_generation, thread_id, request_json,
      recipient_count, state, created_at, expires_at
    ) VALUES (?, 'sender', 1, 'finalize-memory', '{}', ?, 'pending', ?, ?)`)
      .run(broadcastId, count, FINALIZE_NOW.toISOString(), FINALIZE_NOW.addDays(1).toISOString());
    for (const delivery of deliveries) {
      database
        .query(`INSERT INTO e2ee_prekeys(
        prekey_id, agent_id, agent_generation, prekey_class, certificate_json, published_at
      ) VALUES (?, ?, 1, 'fallback', '{}', ?)`)
        .run(delivery.claimId, delivery.recipientId, FINALIZE_NOW.toISOString());
      database
        .query(`INSERT INTO e2ee_claims(
        claim_id, sender_id, sender_generation, recipient_id, recipient_generation,
        prekey_id, prekey_class, request_json, claim_json, broadcast_id, claimed_at, expires_at, consumed_at
      ) VALUES (?, 'sender', 1, ?, 1, ?, 'fallback', '{}', '{}', ?, ?, ?, ?)`)
        .run(
          delivery.claimId,
          delivery.recipientId,
          delivery.claimId,
          broadcastId,
          FINALIZE_NOW.toISOString(),
          FINALIZE_NOW.addDays(1).toISOString(),
          FINALIZE_NOW.toISOString(),
        );
      database
        .query(`INSERT INTO e2ee_broadcast_deliveries(
        broadcast_id, recipient_id, recipient_generation, claim_id, envelope_json,
        sender_chain_json, ciphertext_bytes, accepted_at
      ) VALUES (?, ?, 1, ?, ?, ?, 528, ?)`)
        .run(
          broadcastId,
          delivery.recipientId,
          delivery.claimId,
          JSON.stringify(delivery.envelope),
          JSON.stringify(finalizeSenderChain()),
          FINALIZE_NOW.toISOString(),
        );
    }
    database
      .query(`UPDATE e2ee_usage SET claim_count = ?, pending_broadcast_count = 1,
      pending_delivery_count = ?, pending_ciphertext_bytes = ? WHERE singleton = 1`)
      .run(count, count, count * 528);
    run({ broadcastId, database, deliveries });
  } finally {
    database.close();
  }
}
