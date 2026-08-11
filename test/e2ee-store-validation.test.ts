import { expect, test } from "bun:test";

import type { EncryptedEnvelopeDto, PublicAgentKeyBundleDto } from "../src/e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
} from "../src/e2ee/wire-tools.js";
import { E2EE_CIPHER_SUITE, E2EE_PADDING_SCHEME, E2EE_PROTOCOL } from "../src/e2ee/protocol.js";
import {
  encryptedCiphertextBytes,
  senderChainFromBundle,
  type StoredEncryptionClaim,
  validateEnvelopeForClaim,
} from "../src/storage/e2ee-store-validation.js";

const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const NOW: string = "2026-08-10T17:00:00.000Z";
const EXPIRES_AT: string = "2026-08-11T17:00:00.000Z";
const ROOT_KEY_ID: string = `mrk_${"A".repeat(43)}`;
const AGENT_KEY_ID: string = `mak_${"B".repeat(43)}`;
const PREKEY_ID: string = `mpk_${"C".repeat(43)}`;

function bundle(): PublicAgentKeyBundleDto {
  return {
    agent_certificate: {
      agent_id: "bob",
      created_at: NOW,
      expires_at: EXPIRES_AT,
      root_key_id: ROOT_KEY_ID,
      signature: "D".repeat(86),
      signing_key_id: AGENT_KEY_ID,
      signing_public_key: "E".repeat(43),
    },
    fallback_prekey: {
      agent_id: "bob",
      agent_signing_key_id: AGENT_KEY_ID,
      created_at: NOW,
      expires_at: EXPIRES_AT,
      prekey_class: "fallback",
      prekey_id: PREKEY_ID,
      prekey_public_key: "F".repeat(43),
      signature: "G".repeat(86),
    },
    one_time_prekeys: [],
    root_key_id: ROOT_KEY_ID,
    root_public_key: "H".repeat(43),
  };
}

function storedClaim(): StoredEncryptionClaim {
  const request: ClaimEncryptionPrekeyInput = {
    context: { branch: "main", client: "codex", repository: "owner/repo" },
    recipient_id: "bob",
    sender_id: "alice",
  };
  const claim: ClaimEncryptionPrekeyOutput = {
    bundle: bundle(),
    claim_id: "22222222-2222-4222-8222-222222222222",
    claimed_at: NOW,
    expires_at: "2026-08-10T17:05:00.000Z",
    prekey_class: "fallback",
    prekey_id: PREKEY_ID,
    provenance: {
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    },
    recipient_id: "bob",
  };
  return { claim, recipientGeneration: 1, request, senderGeneration: 1 };
}

function envelope(): EncryptedEnvelopeDto {
  return {
    ciphertext: Buffer.alloc(528, 1).toString("base64url"),
    ephemeral_public_key: "I".repeat(43),
    header: {
      branch_name: "main",
      broadcast_id: null,
      cipher_suite: E2EE_CIPHER_SUITE,
      client: "codex",
      created_at: NOW,
      expires_at: "2026-08-10T18:00:00.000Z",
      idempotency_key: "logical-1",
      message_id: "33333333-3333-4333-8333-333333333333",
      message_kind: "message",
      orchestrator_policy_id: null,
      padded_length: 512,
      padding_scheme: E2EE_PADDING_SCHEME,
      pair_counter: 1,
      protocol: E2EE_PROTOCOL,
      recipient_agent_key_id: AGENT_KEY_ID,
      recipient_id: "bob",
      recipient_prekey_class: "fallback",
      recipient_prekey_id: PREKEY_ID,
      recipient_root_key_id: ROOT_KEY_ID,
      repository_name: "owner/repo",
      sender_agent_key_id: `mak_${"J".repeat(43)}`,
      sender_authority: "peer",
      sender_id: "alice",
      sender_root_key_id: `mrk_${"K".repeat(43)}`,
      tenant_id: TENANT_ID,
      thread_id: "thread-1",
    },
    nonce: "L".repeat(32),
    signature: "M".repeat(86),
  };
}

test("binds every server-derived claim field and ciphertext length", (): void => {
  const value: EncryptedEnvelopeDto = envelope();
  expect(encryptedCiphertextBytes(value)).toBe(528);
  expect(validateEnvelopeForClaim(value, storedClaim(), TENANT_ID, null, NOW)).toEqual(value);

  const relabeled: EncryptedEnvelopeDto = {
    ...value,
    header: { ...value.header, recipient_id: "mallory" },
  };
  expect(
    (): EncryptedEnvelopeDto =>
      validateEnvelopeForClaim(relabeled, storedClaim(), TENANT_ID, null, NOW),
  ).toThrow("does not match");

  const truncated: EncryptedEnvelopeDto = {
    ...value,
    ciphertext: Buffer.alloc(527, 1).toString("base64url"),
  };
  expect((): number => encryptedCiphertextBytes(truncated)).toThrow("length does not match");
});

test("derives a bounded public sender chain without prekeys", (): void => {
  expect(senderChainFromBundle(bundle())).toEqual({
    agent_certificate: bundle().agent_certificate,
    root_key_id: ROOT_KEY_ID,
    root_public_key: "H".repeat(43),
  });
});
