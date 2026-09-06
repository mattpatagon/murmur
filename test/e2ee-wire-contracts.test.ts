import { expect, test } from "bun:test";

import {
  type AgentKeyCertificate,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  prekeyId,
  rootKeyId,
} from "../src/e2ee/certificates.js";
import { decryptEnvelope, encryptEnvelope } from "../src/e2ee/envelope.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeaderInput,
  EnvelopeRandom,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";
import {
  type EncryptedEnvelopeDto,
  envelopeToDto,
  type PublicAgentKeyBundle,
  type PublicAgentKeyBundleDto,
  type PublicAgentSigningChain,
  parseEnvelopeDto,
  parsePublicBundleDto,
  parseSerializedEnvelope,
  parseSigningChainDto,
  publicBundleToDto,
  serializeEnvelope,
  signingChainToDto,
} from "../src/e2ee/wire-contracts.js";

function bytes(length: number, start: number): Uint8Array {
  const result: Uint8Array = new Uint8Array(length);
  for (let index: number = 0; index < result.byteLength; index += 1) {
    result[index] = (start + index) % 256;
  }
  return result;
}

const ROOT_KEY_ID: string = `mrk_${"A".repeat(43)}`;
const AGENT_KEY_ID: string = `mak_${"B".repeat(43)}`;
const PREKEY_ID: string = `mpk_${"C".repeat(43)}`;

class FixedRandom implements EnvelopeRandom {
  readonly #ephemeral: BoxKeyPair;

  public constructor(ephemeral: BoxKeyPair) {
    this.#ephemeral = ephemeral;
  }

  public boxKeyPair(): BoxKeyPair {
    return {
      privateKey: this.#ephemeral.privateKey.slice(),
      publicKey: this.#ephemeral.publicKey.slice(),
    };
  }

  public bytes(length: number): Uint8Array {
    return bytes(length, 211);
  }
}

function header(): EnvelopeHeaderInput {
  return {
    branchName: null,
    broadcastId: null,
    client: "cursor-agent",
    createdAt: "2026-08-10T17:00:00.000Z",
    expiresAt: "2026-09-09T17:00:00.000Z",
    idempotencyKey: "wire-1",
    messageId: "11111111-1111-4111-8111-111111111111",
    messageKind: "orchestration_request",
    orchestratorPolicyId: "22222222-2222-4222-8222-222222222222",
    pairCounter: 7,
    recipientAgentKeyId: AGENT_KEY_ID,
    recipientId: "recipient",
    recipientPrekeyClass: "fallback",
    recipientPrekeyId: PREKEY_ID,
    recipientRootKeyId: ROOT_KEY_ID,
    repositoryName: null,
    senderAgentKeyId: AGENT_KEY_ID,
    senderAuthority: "peer",
    senderId: "sender",
    senderRootKeyId: ROOT_KEY_ID,
    tenantId: "33333333-3333-4333-8333-333333333333",
    threadId: "44444444-4444-4444-8444-444444444444",
  };
}

test("round trips strict public wire envelopes without plaintext or private keys", async (): Promise<void> => {
  const sender: SigningKeyPair = await createSigningKeyPair(bytes(32, 1));
  const recipient: BoxKeyPair = await createBoxKeyPair(bytes(32, 65));
  const ephemeral: BoxKeyPair = await createBoxKeyPair(bytes(32, 129));
  const plaintext: string = "wire plaintext sentinel";
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    header(),
    plaintext,
    sender.privateKey,
    recipient.publicKey,
    new FixedRandom(ephemeral),
  );
  const serialized: string = serializeEnvelope(envelope);
  expect(serialized).not.toContain(plaintext);
  expect(serialized).not.toContain(Buffer.from(sender.privateKey).toString("base64url"));
  expect(serialized).not.toContain(Buffer.from(recipient.privateKey).toString("base64url"));
  const parsed: EncryptedEnvelope = parseSerializedEnvelope(serialized);
  expect(await decryptEnvelope(parsed, sender.publicKey, recipient.privateKey)).toBe(plaintext);
  expect(envelopeToDto(parsed)).toEqual(envelopeToDto(envelope));

  const changedPolicy: EncryptedEnvelope = {
    ...parsed,
    header: {
      ...parsed.header,
      orchestratorPolicyId: "55555555-5555-4555-8555-555555555555",
    },
  };
  await expect(
    decryptEnvelope(changedPolicy, sender.publicKey, recipient.privateKey),
  ).rejects.toThrow("Encrypted message verification failed");
  const changedAuthority: EncryptedEnvelope = {
    ...parsed,
    header: { ...parsed.header, senderAuthority: "orchestrator" },
  };
  await expect(
    decryptEnvelope(changedAuthority, sender.publicKey, recipient.privateKey),
  ).rejects.toThrow("Encrypted message verification failed");
  const changedKind: EncryptedEnvelope = {
    ...parsed,
    header: { ...parsed.header, messageKind: "message" },
  };
  await expect(
    decryptEnvelope(changedKind, sender.publicKey, recipient.privateKey),
  ).rejects.toThrow("Encrypted message verification failed");
});

test("rejects noncanonical, malformed, and length-conflicting envelope bytes", async (): Promise<void> => {
  const sender: SigningKeyPair = await createSigningKeyPair(bytes(32, 2));
  const recipient: BoxKeyPair = await createBoxKeyPair(bytes(32, 66));
  const ephemeral: BoxKeyPair = await createBoxKeyPair(bytes(32, 130));
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    header(),
    "secret",
    sender.privateKey,
    recipient.publicKey,
    new FixedRandom(ephemeral),
  );
  const dto: EncryptedEnvelopeDto = envelopeToDto(envelope);
  expect((): EncryptedEnvelope => parseEnvelopeDto({ ...dto, nonce: `${dto.nonce}=` })).toThrow();
  expect(
    (): EncryptedEnvelope => parseEnvelopeDto({ ...dto, ciphertext: dto.ciphertext.slice(1) }),
  ).toThrow("canonical base64url");
  expect(
    (): EncryptedEnvelope =>
      parseEnvelopeDto({ ...dto, header: { ...dto.header, client: "Cursor" } }),
  ).toThrow();
  expect(
    (): EncryptedEnvelope =>
      parseEnvelopeDto({
        ...dto,
        header: { ...dto.header, padded_length: 768 },
      }),
  ).toThrow();
  expect((): EncryptedEnvelope => parseEnvelopeDto({ ...dto, private_key: "forbidden" })).toThrow();
  expect((): EncryptedEnvelope => parseSerializedEnvelope("{")).toThrow(
    "Serialized encrypted envelope is invalid",
  );
});

test("round trips a public-only certified agent bundle", async (): Promise<void> => {
  const root: SigningKeyPair = await createSigningKeyPair(bytes(32, 3));
  const agent: SigningKeyPair = await createSigningKeyPair(bytes(32, 35));
  const fallback: BoxKeyPair = await createBoxKeyPair(bytes(32, 67));
  const oneTime: BoxKeyPair = await createBoxKeyPair(bytes(32, 99));
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId: "recipient",
      createdAt: "2026-08-10T17:00:00.000Z",
      expiresAt: "2026-11-08T17:00:00.000Z",
      rootKeyId: await rootKeyId(root.publicKey),
      signingKeyId: await agentSigningKeyId(agent.publicKey),
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
  const fallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId: "recipient",
      agentSigningKeyId: agentCertificate.signingKeyId,
      createdAt: "2026-08-10T17:00:00.000Z",
      expiresAt: "2026-09-09T17:00:00.000Z",
      prekeyClass: "fallback",
      prekeyId: await prekeyId(fallback.publicKey),
      prekeyPublicKey: fallback.publicKey,
    },
    agent.privateKey,
  );
  const oneTimeCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      ...fallbackCertificate,
      prekeyClass: "one_time",
      prekeyId: await prekeyId(oneTime.publicKey),
      prekeyPublicKey: oneTime.publicKey,
    },
    agent.privateKey,
  );
  const dto: PublicAgentKeyBundleDto = publicBundleToDto(
    root.publicKey,
    agentCertificate,
    fallbackCertificate,
    [oneTimeCertificate],
  );
  const parsed: PublicAgentKeyBundle = parsePublicBundleDto(dto);
  expect(parsed.rootPublicKey).toEqual(root.publicKey);
  expect(parsed.agentCertificate).toEqual(agentCertificate);
  expect(parsed.fallbackPrekey).toEqual(fallbackCertificate);
  expect(parsed.oneTimePrekeys).toEqual([oneTimeCertificate]);
  const rendered: string = JSON.stringify(dto);
  expect(rendered).not.toContain(Buffer.from(root.privateKey).toString("base64url"));
  expect(rendered).not.toContain(Buffer.from(agent.privateKey).toString("base64url"));
  expect(rendered).not.toContain(Buffer.from(fallback.privateKey).toString("base64url"));
  expect(
    (): PublicAgentKeyBundle => parsePublicBundleDto({ ...dto, private_key: "forbidden" }),
  ).toThrow();
  expect(
    (): PublicAgentKeyBundle =>
      parsePublicBundleDto({
        ...dto,
        one_time_prekeys: [dto.fallback_prekey],
      }),
  ).toThrow("Bundle one-time prekey has the wrong class");
  expect(
    (): PublicAgentKeyBundle =>
      parsePublicBundleDto({
        ...dto,
        one_time_prekeys: Array.from(
          { length: 101 },
          (): PublicAgentKeyBundleDto["fallback_prekey"] => dto.fallback_prekey,
        ),
      }),
  ).toThrow();
  const signingChain: PublicAgentSigningChain = parseSigningChainDto(
    signingChainToDto(root.publicKey, agentCertificate),
  );
  expect(signingChain.rootPublicKey).toEqual(root.publicKey);
  expect(signingChain.agentCertificate).toEqual(agentCertificate);
  expect(
    (): PublicAgentSigningChain =>
      parseSigningChainDto({
        ...signingChainToDto(root.publicKey, agentCertificate),
        private_key: "forbidden",
      }),
  ).toThrow();
});
