import { expect, test } from "bun:test";

import {
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  prekeyId,
  rootKeyId,
  type AgentKeyCertificate,
  type PrekeyCertificate,
} from "../src/e2ee/certificates.js";
import { encryptEnvelope } from "../src/e2ee/envelope.js";
import {
  verifyHostedEncryptedEnvelope,
  verifyHostedPublicBundle,
} from "../src/e2ee/hosted-validation.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeaderInput,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";
import {
  envelopeToDto,
  type PublicAgentKeyBundleDto,
  publicBundleToDto,
  type PublicAgentSigningChainDto,
  signingChainToDto,
} from "../src/e2ee/wire-contracts.js";
import type {
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  PutEncryptedMessageInput,
} from "../src/e2ee/wire-tools.js";

const NOW: Date = new Date("2026-08-10T20:00:00.000Z");
const CREATED: string = "2026-08-10T19:00:00.000Z";
const KEY_EXPIRES: string = "2026-09-16T20:00:00.000Z";
const AGENT_EXPIRES: string = "2026-11-08T20:00:00.000Z";
const MESSAGE_EXPIRES: string = "2026-09-09T20:00:00.000Z";
const TENANT_ID: string = "00000000-0000-4000-8000-000000000010";

type Identity = {
  readonly agent: SigningKeyPair;
  readonly agentCertificate: AgentKeyCertificate;
  readonly fallback: BoxKeyPair;
  readonly fallbackCertificate: PrekeyCertificate;
  readonly oneTime: BoxKeyPair;
  readonly oneTimeCertificate: PrekeyCertificate;
  readonly root: SigningKeyPair;
};

function seed(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

async function identity(agentId: string, offset: number): Promise<Identity> {
  const root: SigningKeyPair = await createSigningKeyPair(seed(offset));
  const agent: SigningKeyPair = await createSigningKeyPair(seed(offset + 1));
  const rootId: string = await rootKeyId(root.publicKey);
  const signingKeyId: string = await agentSigningKeyId(agent.publicKey);
  const agentCertificate: AgentKeyCertificate = await createAgentKeyCertificate(
    {
      agentId,
      createdAt: CREATED,
      expiresAt: AGENT_EXPIRES,
      rootKeyId: rootId,
      signingKeyId,
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
  const fallback: BoxKeyPair = await createBoxKeyPair(seed(offset + 2));
  const oneTime: BoxKeyPair = await createBoxKeyPair(seed(offset + 3));
  const fallbackCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt: CREATED,
      expiresAt: KEY_EXPIRES,
      prekeyClass: "fallback",
      prekeyId: await prekeyId(fallback.publicKey),
      prekeyPublicKey: fallback.publicKey,
    },
    agent.privateKey,
  );
  const oneTimeCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId,
      agentSigningKeyId: signingKeyId,
      createdAt: CREATED,
      expiresAt: KEY_EXPIRES,
      prekeyClass: "one_time",
      prekeyId: await prekeyId(oneTime.publicKey),
      prekeyPublicKey: oneTime.publicKey,
    },
    agent.privateKey,
  );
  return {
    agent,
    agentCertificate,
    fallback,
    fallbackCertificate,
    oneTime,
    oneTimeCertificate,
    root,
  };
}

function bundle(value: Identity): PublicAgentKeyBundleDto {
  return publicBundleToDto(
    value.root.publicKey,
    value.agentCertificate,
    value.fallbackCertificate,
    [value.oneTimeCertificate],
  );
}

function chain(value: Identity): PublicAgentSigningChainDto {
  return signingChainToDto(value.root.publicKey, value.agentCertificate);
}

function claimInput(): ClaimEncryptionPrekeyInput {
  return {
    context: {
      branch: "feature/e2ee",
      client: "codex",
      repository: "mattpatagon/murmur",
    },
    recipient_id: "recipient",
    sender_id: "sender",
  };
}

function claimOutput(recipient: Identity): ClaimEncryptionPrekeyOutput {
  return {
    bundle: bundle(recipient),
    claim_id: "00000000-0000-4000-8000-000000000020",
    claimed_at: "2026-08-10T19:59:00.000Z",
    expires_at: "2026-08-10T20:02:00.000Z",
    prekey_class: "one_time",
    prekey_id: recipient.oneTimeCertificate.prekeyId,
    provenance: {
      message_kind: "message",
      orchestrator_policy_id: null,
      sender_authority: "peer",
    },
    recipient_id: "recipient",
  };
}

function header(sender: Identity, recipient: Identity): EnvelopeHeaderInput {
  return {
    branchName: "feature/e2ee",
    broadcastId: null,
    client: "codex",
    createdAt: NOW.toISOString(),
    expiresAt: MESSAGE_EXPIRES,
    idempotencyKey: "hosted-validation-1",
    messageId: "00000000-0000-4000-8000-000000000030",
    messageKind: "message",
    orchestratorPolicyId: null,
    pairCounter: 1,
    recipientAgentKeyId: recipient.agentCertificate.signingKeyId,
    recipientId: "recipient",
    recipientPrekeyClass: "one_time",
    recipientPrekeyId: recipient.oneTimeCertificate.prekeyId,
    recipientRootKeyId: recipient.agentCertificate.rootKeyId,
    repositoryName: "mattpatagon/murmur",
    senderAgentKeyId: sender.agentCertificate.signingKeyId,
    senderAuthority: "peer",
    senderId: "sender",
    senderRootKeyId: sender.agentCertificate.rootKeyId,
    tenantId: TENANT_ID,
    threadId: "thread-1",
  };
}

async function put(
  sender: Identity,
  recipient: Identity,
  envelopeHeader: EnvelopeHeaderInput,
): Promise<PutEncryptedMessageInput> {
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    envelopeHeader,
    "hosted validation plaintext",
    sender.agent.privateKey,
    recipient.oneTime.publicKey,
  );
  return {
    claim_id: "00000000-0000-4000-8000-000000000020",
    envelope: envelopeToDto(envelope),
  };
}

test("hosted validation accepts certified bundles and a fully bound signed delivery", async (): Promise<void> => {
  const sender: Identity = await identity("sender", 1);
  const recipient: Identity = await identity("recipient", 10);
  await expect(
    verifyHostedPublicBundle("recipient", bundle(recipient), NOW, 20),
  ).resolves.toMatchObject({ rootKeyId: recipient.agentCertificate.rootKeyId });
  const encryptedPut: PutEncryptedMessageInput = await put(
    sender,
    recipient,
    header(sender, recipient),
  );
  await expect(
    verifyHostedEncryptedEnvelope({
      claimInput: claimInput(),
      claimOutput: claimOutput(recipient),
      expectedBroadcastId: null,
      maxCiphertextBytes: 524_304,
      now: NOW,
      putInput: encryptedPut,
      senderChain: chain(sender),
      tenantId: TENANT_ID,
    }),
  ).resolves.toMatchObject({ header: { messageId: "00000000-0000-4000-8000-000000000030" } });
});

test("hosted validation rejects validly signed tenant, context, provenance, and claim relabeling", async (): Promise<void> => {
  const sender: Identity = await identity("sender", 20);
  const recipient: Identity = await identity("recipient", 30);
  const base: EnvelopeHeaderInput = header(sender, recipient);
  const malicious: readonly EnvelopeHeaderInput[] = [
    { ...base, tenantId: "00000000-0000-4000-8000-000000000099" },
    { ...base, repositoryName: "mallory/other" },
    {
      ...base,
      messageKind: "orchestration_request",
      orchestratorPolicyId: "00000000-0000-4000-8000-000000000098",
      senderAuthority: "orchestrator",
    },
    { ...base, broadcastId: "00000000-0000-4000-8000-000000000097" },
    { ...base, recipientPrekeyId: `mpk_${"Z".repeat(43)}` },
  ];
  for (const changed of malicious) {
    await expect(
      verifyHostedEncryptedEnvelope({
        claimInput: claimInput(),
        claimOutput: claimOutput(recipient),
        expectedBroadcastId: null,
        maxCiphertextBytes: 524_304,
        now: NOW,
        putInput: await put(sender, recipient, changed),
        senderChain: chain(sender),
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow("Hosted encrypted message validation failed");
  }
  const validPut: PutEncryptedMessageInput = await put(sender, recipient, base);
  await expect(
    verifyHostedEncryptedEnvelope({
      claimInput: claimInput(),
      claimOutput: claimOutput(recipient),
      expectedBroadcastId: null,
      maxCiphertextBytes: 524_304,
      now: NOW,
      putInput: {
        ...validPut,
        claim_id: "00000000-0000-4000-8000-000000000096",
      },
      senderChain: chain(sender),
      tenantId: TENANT_ID,
    }),
  ).rejects.toThrow("Hosted encrypted message validation failed");
  await expect(
    verifyHostedEncryptedEnvelope({
      claimInput: claimInput(),
      claimOutput: { ...claimOutput(recipient), expires_at: "2026-08-10T19:59:59.000Z" },
      expectedBroadcastId: null,
      maxCiphertextBytes: 524_304,
      now: NOW,
      putInput: validPut,
      senderChain: chain(sender),
      tenantId: TENANT_ID,
    }),
  ).rejects.toThrow("Hosted encrypted message validation failed");
  await expect(
    verifyHostedEncryptedEnvelope({
      claimInput: claimInput(),
      claimOutput: claimOutput(recipient),
      expectedBroadcastId: null,
      maxCiphertextBytes: 1,
      now: NOW,
      putInput: validPut,
      senderChain: chain(sender),
      tenantId: TENANT_ID,
    }),
  ).rejects.toThrow("Hosted encrypted message validation failed");
});

test("hosted bundle validation rejects a substituted public certificate signature", async (): Promise<void> => {
  const recipient: Identity = await identity("recipient", 40);
  const tampered: PublicAgentKeyBundleDto = {
    ...bundle(recipient),
    agent_certificate: { ...bundle(recipient).agent_certificate, signature: "A".repeat(86) },
  };
  await expect(verifyHostedPublicBundle("recipient", tampered, NOW, 20)).rejects.toThrow(
    "Published E2E key bundle validation failed",
  );
});
