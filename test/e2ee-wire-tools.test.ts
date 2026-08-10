import { expect, test } from "bun:test";

import type { PublicAgentKeyBundleDto } from "../src/e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  ClaimedProvenanceDtoSchema,
  E2eeCapabilityInputSchema,
  type EncryptedBroadcastClaimDto,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
  type PublishAgentKeyBundleInput,
  PublishAgentKeyBundleInputSchema,
} from "../src/e2ee/wire-tools.js";

const ROOT_KEY_ID: string = `mrk_${"A".repeat(43)}`;
const AGENT_KEY_ID: string = `mak_${"B".repeat(43)}`;
const FALLBACK_PREKEY_ID: string = `mpk_${"C".repeat(43)}`;
const ONE_TIME_PREKEY_ID: string = `mpk_${"D".repeat(43)}`;
const PUBLIC_KEY: string = "E".repeat(43);
const SIGNATURE: string = "F".repeat(86);
const CREATED_AT: string = "2026-08-10T17:00:00.000Z";
const EXPIRES_AT: string = "2026-09-09T17:00:00.000Z";

function publicBundle(agentId: string): PublicAgentKeyBundleDto {
  return {
    agent_certificate: {
      agent_id: agentId,
      created_at: CREATED_AT,
      expires_at: EXPIRES_AT,
      root_key_id: ROOT_KEY_ID,
      signature: SIGNATURE,
      signing_key_id: AGENT_KEY_ID,
      signing_public_key: PUBLIC_KEY,
    },
    fallback_prekey: {
      agent_id: agentId,
      agent_signing_key_id: AGENT_KEY_ID,
      created_at: CREATED_AT,
      expires_at: EXPIRES_AT,
      prekey_class: "fallback",
      prekey_id: FALLBACK_PREKEY_ID,
      prekey_public_key: PUBLIC_KEY,
      signature: SIGNATURE,
    },
    one_time_prekeys: [
      {
        agent_id: agentId,
        agent_signing_key_id: AGENT_KEY_ID,
        created_at: CREATED_AT,
        expires_at: EXPIRES_AT,
        prekey_class: "one_time",
        prekey_id: ONE_TIME_PREKEY_ID,
        prekey_public_key: PUBLIC_KEY,
        signature: SIGNATURE,
      },
    ],
    root_key_id: ROOT_KEY_ID,
    root_public_key: PUBLIC_KEY,
  };
}

function claim(recipientId: string, claimId: string): EncryptedBroadcastClaimDto {
  return {
    bundle: publicBundle(recipientId),
    claim_id: claimId,
    claimed_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    prekey_class: "one_time",
    prekey_id: ONE_TIME_PREKEY_ID,
    provenance: {
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    },
    recipient_id: recipientId,
  };
}

test("keeps entitlement state server-derived and publishes only matching public bundles", (): void => {
  expect(E2eeCapabilityInputSchema.parse({})).toEqual({});
  expect(
    (): Record<string, never> => E2eeCapabilityInputSchema.parse({ state: "enforced" }),
  ).toThrow();
  const valid: PublishAgentKeyBundleInput = {
    agent_id: "alice",
    bundle: publicBundle("alice"),
  };
  expect(PublishAgentKeyBundleInputSchema.parse(valid)).toEqual(valid);
  expect(
    (): PublishAgentKeyBundleInput =>
      PublishAgentKeyBundleInputSchema.parse({ ...valid, agent_id: "mallory" }),
  ).toThrow("identity mismatch");
  expect(
    (): PublishAgentKeyBundleInput =>
      PublishAgentKeyBundleInputSchema.parse({ ...valid, private_key: "forbidden" }),
  ).toThrow();
});

test("requires claimed prekeys and provenance to be internally consistent", (): void => {
  const valid: ClaimEncryptionPrekeyOutput = claim("alice", "11111111-1111-4111-8111-111111111111");
  expect(ClaimEncryptionPrekeyOutputSchema.parse(valid)).toEqual(valid);
  expect(
    (): ClaimEncryptionPrekeyOutput =>
      ClaimEncryptionPrekeyOutputSchema.parse({
        ...valid,
        prekey_id: `mpk_${"G".repeat(43)}`,
      }),
  ).toThrow("absent from its bundle");
  expect((): unknown =>
    ClaimedProvenanceDtoSchema.parse({
      message_kind: "orchestration_request",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    }),
  ).toThrow("inconsistent");
});

test("requires exact sorted broadcast snapshots with no hidden content field", (): void => {
  const first: EncryptedBroadcastClaimDto = claim("alice", "11111111-1111-4111-8111-111111111111");
  const second: EncryptedBroadcastClaimDto = claim("bob", "22222222-2222-4222-8222-222222222222");
  const output: PrepareEncryptedBroadcastOutput = {
    broadcast_id: "33333333-3333-4333-8333-333333333333",
    claims: [first, second],
    duplicate: false,
    expires_at: EXPIRES_AT,
    recipient_count: 2,
    thread_id: "44444444-4444-4444-8444-444444444444",
  };
  expect(PrepareEncryptedBroadcastOutputSchema.parse(output)).toEqual(output);
  expect(
    (): PrepareEncryptedBroadcastOutput =>
      PrepareEncryptedBroadcastOutputSchema.parse({ ...output, claims: [second, first] }),
  ).toThrow("sorted and unique");
  expect(
    (): PrepareEncryptedBroadcastOutput =>
      PrepareEncryptedBroadcastOutputSchema.parse({ ...output, recipient_count: 1 }),
  ).toThrow("count mismatch");
  expect(
    (): PrepareEncryptedBroadcastOutput =>
      PrepareEncryptedBroadcastOutputSchema.parse({ ...output, content: "forbidden" }),
  ).toThrow();
});
