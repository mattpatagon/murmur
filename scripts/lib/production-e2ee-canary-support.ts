import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { PrekeyCertificateDto } from "../../src/e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyOutput,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type EncryptedMessageDto,
} from "../../src/e2ee/wire-tools.js";
import type { ProductionHarness } from "./production-hosted-harness.js";
import { callProductionTool } from "./production-hosted-harness.js";

export type ProductionE2eeCanaryState = {
  readonly adminSecret: string;
  readonly orchestratorKeyId: string;
  readonly orchestratorSecret: string;
  readonly receiverSecret: string;
  readonly senderSecret: string;
  readonly tenantId: string;
};

export type ProductionE2eeEndpoints = {
  readonly admin: ProductionHarness;
  readonly orchestrator: ProductionHarness;
  readonly receiver: ProductionHarness;
  readonly sender: ProductionHarness;
};

const IndependentVerificationSchema: z.ZodType<{
  readonly message_id: string;
  readonly outer_header_blake2b_256: string;
  readonly protocol: "murmur-e2ee-v1";
  readonly recipient_root_key_id: string;
  readonly sender_root_key_id: string;
  readonly signature_verified: true;
}> = z.strictObject({
  message_id: z.string().uuid(),
  outer_header_blake2b_256: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: z.literal("murmur-e2ee-v1"),
  recipient_root_key_id: z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u),
  sender_root_key_id: z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u),
  signature_verified: z.literal(true),
});

function claimedPrekey(claim: ClaimEncryptionPrekeyOutput): PrekeyCertificateDto {
  if (claim.prekey_class === "fallback") return claim.bundle.fallback_prekey;
  const certificate: PrekeyCertificateDto | undefined = claim.bundle.one_time_prekeys.find(
    (candidate: PrekeyCertificateDto): boolean => candidate.prekey_id === claim.prekey_id,
  );
  if (certificate === undefined) throw new Error("Production E2E claim omitted its prekey");
  return certificate;
}

export async function independentlyVerifyLiveEnvelope(
  message: EncryptedMessageDto,
  claim: ClaimEncryptionPrekeyOutput,
): Promise<void> {
  const capture: Record<string, unknown> = {
    envelope: message.envelope,
    recipient: {
      agent_certificate: claim.bundle.agent_certificate,
      prekey_certificate: claimedPrekey(claim),
      root_public_key: claim.bundle.root_public_key,
    },
    sender: {
      agent_certificate: message.sender_chain.agent_certificate,
      root_public_key: message.sender_chain.root_public_key,
    },
  };
  const verificationTime: string = new Date().toISOString();
  const directory: string = await mkdtemp(join(tmpdir(), "murmur-e2ee-canary-"));
  const capturePath: string = join(directory, "capture.json");
  try {
    await writeFile(capturePath, JSON.stringify(capture), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const verifierPath: string = fileURLToPath(
      new URL("../verify-e2ee-capture.ts", import.meta.url),
    );
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      [process.execPath, verifierPath, capturePath, verificationTime],
      { stderr: "pipe", stdin: "ignore", stdout: "pipe" },
    );
    const output: string = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    if ((await child.exited) !== 0) {
      throw new Error("Independent production envelope verifier failed");
    }
    const verified: z.infer<typeof IndependentVerificationSchema> =
      IndependentVerificationSchema.parse(JSON.parse(output));
    if (verified.message_id !== message.envelope.header.message_id) {
      throw new Error("Independent verifier returned a different production message");
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function liveEncryptedMessages(
  endpoint: ProductionHarness,
  agentId: string,
): Promise<readonly EncryptedMessageDto[]> {
  const inbox: EncryptedInboxOutput = EncryptedInboxOutputSchema.parse(
    await callProductionTool(endpoint, "get_encrypted_messages", {
      after_sequence: 0,
      agent_id: agentId,
      limit: 100,
      unread_only: false,
    }),
  );
  return inbox.messages;
}

export async function liveEncryptedMessage(
  endpoint: ProductionHarness,
  agentId: string,
  messageId: string,
): Promise<EncryptedMessageDto> {
  const message: EncryptedMessageDto | undefined = (
    await liveEncryptedMessages(endpoint, agentId)
  ).find(
    (candidate: EncryptedMessageDto): boolean => candidate.envelope.header.message_id === messageId,
  );
  if (message === undefined) throw new Error("Production encrypted inbox omitted a live message");
  return message;
}
