import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedEnvelopeInput,
  digestCanonicalEnvelopeHeader,
  type IndependentHeaderDigest,
  type IndependentVerification,
  verifyCapturedEnvelope,
} from "../scripts/e2ee-independent-verifier.js";
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
import { encryptEnvelope } from "../src/e2ee/envelope.js";
import type {
  BoxKeyPair,
  EncryptedEnvelope,
  EnvelopeHeaderInput,
  EnvelopeRandom,
  SigningKeyPair,
} from "../src/e2ee/protocol.js";
import {
  type AgentKeyCertificateDto,
  envelopeToDto,
  type PrekeyCertificateDto,
} from "../src/e2ee/wire-contracts.js";

const NOW: Date = new Date("2026-08-10T18:00:00.000Z");
const CIPHER_SUITE: "x25519-xsalsa20-poly1305+ed25519" =
  // biome-ignore lint/security/noSecrets: This is a public cipher-suite identifier, not credential material.
  "x25519-xsalsa20-poly1305+ed25519";

function fixedVectorHeader(): Record<string, unknown> {
  return {
    branch_name: "feature/e2ee",
    broadcast_id: null,
    cipher_suite: CIPHER_SUITE,
    client: "codex",
    created_at: "2026-08-10T17:00:00.000Z",
    expires_at: "2026-09-09T17:00:00.000Z",
    idempotency_key: "send-0001",
    message_id: "11111111-1111-4111-8111-111111111111",
    message_kind: "message",
    orchestrator_policy_id: null,
    padded_length: 1024,
    padding_scheme: "power-of-two-v1",
    pair_counter: 1,
    protocol: "murmur-e2ee-v1",
    recipient_agent_key_id: `mak_${"A".repeat(43)}`,
    recipient_id: "machine-b:codex:repo-b:recipient",
    recipient_prekey_class: "one_time",
    recipient_prekey_id: `mpk_${"B".repeat(43)}`,
    recipient_root_key_id: `mrk_${"C".repeat(43)}`,
    repository_name: "mattpatagon/murmur",
    sender_agent_key_id: `mak_${"D".repeat(43)}`,
    sender_authority: "peer",
    sender_id: "machine-a:codex:repo-a:sender",
    sender_root_key_id: `mrk_${"E".repeat(43)}`,
    tenant_id: "22222222-2222-4222-8222-222222222222",
    thread_id: "33333333-3333-4333-8333-333333333333",
  };
}

function bytes(length: number, start: number): Uint8Array {
  const output: Uint8Array = new Uint8Array(length);
  for (let index: number = 0; index < output.byteLength; index += 1) {
    output[index] = (start + index) % 256;
  }
  return output;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

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

function agentCertificateDto(certificate: AgentKeyCertificate): AgentKeyCertificateDto {
  return {
    agent_id: certificate.agentId,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    root_key_id: certificate.rootKeyId,
    signature: encode(certificate.signature),
    signing_key_id: certificate.signingKeyId,
    signing_public_key: encode(certificate.signingPublicKey),
  };
}

function prekeyCertificateDto(certificate: PrekeyCertificate): PrekeyCertificateDto {
  return {
    agent_id: certificate.agentId,
    agent_signing_key_id: certificate.agentSigningKeyId,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    prekey_class: certificate.prekeyClass,
    prekey_id: certificate.prekeyId,
    prekey_public_key: encode(certificate.prekeyPublicKey),
    signature: encode(certificate.signature),
  };
}

async function certificate(
  agentId: string,
  root: SigningKeyPair,
  agent: SigningKeyPair,
): Promise<AgentKeyCertificate> {
  return createAgentKeyCertificate(
    {
      agentId,
      createdAt: "2026-08-10T16:00:00.000Z",
      expiresAt: "2026-11-08T16:00:00.000Z",
      rootKeyId: await rootKeyId(root.publicKey),
      signingKeyId: await agentSigningKeyId(agent.publicKey),
      signingPublicKey: agent.publicKey,
    },
    root.privateKey,
  );
}

async function capturedEnvelope(): Promise<{
  readonly captured: CapturedEnvelopeInput;
  readonly recipientPrivateKey: Uint8Array;
  readonly senderPrivateKey: Uint8Array;
}> {
  const senderRoot: SigningKeyPair = await createSigningKeyPair(bytes(32, 1));
  const senderAgent: SigningKeyPair = await createSigningKeyPair(bytes(32, 33));
  const recipientRoot: SigningKeyPair = await createSigningKeyPair(bytes(32, 65));
  const recipientAgent: SigningKeyPair = await createSigningKeyPair(bytes(32, 97));
  const recipientPrekey: BoxKeyPair = await createBoxKeyPair(bytes(32, 129));
  const ephemeral: BoxKeyPair = await createBoxKeyPair(bytes(32, 161));
  const senderCertificate: AgentKeyCertificate = await certificate(
    "machine-a:codex:repo-a:sender",
    senderRoot,
    senderAgent,
  );
  const recipientCertificate: AgentKeyCertificate = await certificate(
    "machine-b:codex:repo-b:recipient",
    recipientRoot,
    recipientAgent,
  );
  const recipientPrekeyCertificate: PrekeyCertificate = await createPrekeyCertificate(
    {
      agentId: recipientCertificate.agentId,
      agentSigningKeyId: recipientCertificate.signingKeyId,
      createdAt: "2026-08-10T16:30:00.000Z",
      expiresAt: "2026-09-09T16:30:00.000Z",
      prekeyClass: "one_time",
      prekeyId: await prekeyId(recipientPrekey.publicKey),
      prekeyPublicKey: recipientPrekey.publicKey,
    },
    recipientAgent.privateKey,
  );
  const header: EnvelopeHeaderInput = {
    branchName: "feature/e2ee",
    broadcastId: null,
    client: "codex",
    createdAt: "2026-08-10T17:00:00.000Z",
    expiresAt: "2026-09-09T17:00:00.000Z",
    idempotencyKey: "send-0001",
    messageId: "11111111-1111-4111-8111-111111111111",
    messageKind: "message",
    orchestratorPolicyId: null,
    pairCounter: 1,
    recipientAgentKeyId: recipientCertificate.signingKeyId,
    recipientId: recipientCertificate.agentId,
    recipientPrekeyClass: recipientPrekeyCertificate.prekeyClass,
    recipientPrekeyId: recipientPrekeyCertificate.prekeyId,
    recipientRootKeyId: recipientCertificate.rootKeyId,
    repositoryName: "mattpatagon/murmur",
    senderAgentKeyId: senderCertificate.signingKeyId,
    senderAuthority: "peer",
    senderId: senderCertificate.agentId,
    senderRootKeyId: senderCertificate.rootKeyId,
    tenantId: "22222222-2222-4222-8222-222222222222",
    threadId: "33333333-3333-4333-8333-333333333333",
  };
  const envelope: EncryptedEnvelope = await encryptEnvelope(
    header,
    "independent verifier plaintext sentinel",
    senderAgent.privateKey,
    recipientPrekey.publicKey,
    new FixedRandom(ephemeral),
  );
  return {
    captured: {
      envelope: envelopeToDto(envelope),
      recipient: {
        agent_certificate: agentCertificateDto(recipientCertificate),
        prekey_certificate: prekeyCertificateDto(recipientPrekeyCertificate),
        root_public_key: encode(recipientRoot.publicKey),
      },
      sender: {
        agent_certificate: agentCertificateDto(senderCertificate),
        root_public_key: encode(senderRoot.publicKey),
      },
    },
    recipientPrivateKey: recipientPrekey.privateKey,
    senderPrivateKey: senderAgent.privateKey,
  };
}

test("independently verifies a captured envelope using public material only", async (): Promise<void> => {
  const fixture: Awaited<ReturnType<typeof capturedEnvelope>> = await capturedEnvelope();
  const rendered: string = JSON.stringify(fixture.captured);
  expect(rendered).not.toContain("independent verifier plaintext sentinel");
  expect(rendered).not.toContain(encode(fixture.senderPrivateKey));
  expect(rendered).not.toContain(encode(fixture.recipientPrivateKey));
  const result: IndependentVerification = await verifyCapturedEnvelope(fixture.captured, NOW);
  expect(result).toEqual({
    message_id: fixture.captured.envelope.header.message_id,
    outer_header_blake2b_256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    protocol: "murmur-e2ee-v1",
    recipient_root_key_id: fixture.captured.envelope.header.recipient_root_key_id,
    sender_root_key_id: fixture.captured.envelope.header.sender_root_key_id,
    signature_verified: true,
  });
  const verifierSource: string = readFileSync(
    new URL("../scripts/e2ee-independent-verifier.ts", import.meta.url),
    "utf8",
  );
  expect(verifierSource).not.toMatch(/from\s+["'][^"']*src\/e2ee/u);
});

test("reproduces the documented header vector without runtime encoding imports", async (): Promise<void> => {
  const result: IndependentHeaderDigest = await digestCanonicalEnvelopeHeader(fixedVectorHeader());
  expect(result).toEqual({
    byte_length: 708,
    outer_header_blake2b_256:
      // biome-ignore lint/security/noSecrets: This is the documented public vector digest, not secret material.
      "feac7159f60e1f6760d2c2e589b19fd221279b71e12d226feda484d4ec2cd95a",
  });
});

test("independent verification rejects public-chain, context, and ciphertext tampering", async (): Promise<void> => {
  const fixture: Awaited<ReturnType<typeof capturedEnvelope>> = await capturedEnvelope();
  await expect(
    verifyCapturedEnvelope(
      {
        ...fixture.captured,
        envelope: {
          ...fixture.captured.envelope,
          header: {
            ...fixture.captured.envelope.header,
            repository_name: "mattpatagon/other",
          },
        },
      },
      NOW,
    ),
  ).rejects.toThrow("Independent encrypted envelope verification failed");
  await expect(
    verifyCapturedEnvelope(
      {
        ...fixture.captured,
        envelope: {
          ...fixture.captured.envelope,
          ciphertext: `A${fixture.captured.envelope.ciphertext.slice(1)}`,
        },
      },
      NOW,
    ),
  ).rejects.toThrow("Independent encrypted envelope verification failed");
  await expect(
    verifyCapturedEnvelope(
      {
        ...fixture.captured,
        sender: { ...fixture.captured.sender, root_public_key: "A".repeat(43) },
      },
      NOW,
    ),
  ).rejects.toThrow("Independent encrypted envelope verification failed");
});

test("runs the bounded independent verifier as a portable CLI", async (): Promise<void> => {
  const fixture: Awaited<ReturnType<typeof capturedEnvelope>> = await capturedEnvelope();
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-capture-"));
  const path: string = join(directory, "capture.json");
  try {
    writeFileSync(path, JSON.stringify(fixture.captured), { encoding: "utf8", mode: 0o600 });
    const result: Bun.ReadableSyncSubprocess = Bun.spawnSync({
      cmd: [process.execPath, "run", "scripts/verify-e2ee-capture.ts", path, NOW.toISOString()],
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output: IndependentVerification = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(output.message_id).toBe(fixture.captured.envelope.header.message_id);
    expect(output.signature_verified).toBe(true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
