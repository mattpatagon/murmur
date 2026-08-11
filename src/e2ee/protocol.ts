export const E2EE_PROTOCOL: "murmur-e2ee-v1" = "murmur-e2ee-v1";
export const E2EE_CIPHER_SUITE: "x25519-xsalsa20-poly1305+ed25519" =
  // biome-ignore lint/security/noSecrets: This is a public cipher-suite identifier, not credential material.
  "x25519-xsalsa20-poly1305+ed25519";
export const E2EE_PADDING_SCHEME: "power-of-two-v1" = "power-of-two-v1";

export type SenderAuthority = "orchestrator" | "peer";
export type MessageKind = "message" | "orchestration_request";
export type PrekeyClass = "fallback" | "one_time";

export type EnvelopeHeaderInput = {
  readonly branchName: string | null;
  readonly broadcastId: string | null;
  readonly client: "claude" | "codex" | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly messageKind: MessageKind;
  readonly orchestratorPolicyId: string | null;
  readonly pairCounter: number;
  readonly recipientAgentKeyId: string;
  readonly recipientId: string;
  readonly recipientPrekeyClass: PrekeyClass;
  readonly recipientPrekeyId: string;
  readonly recipientRootKeyId: string;
  readonly repositoryName: string | null;
  readonly senderAgentKeyId: string;
  readonly senderAuthority: SenderAuthority;
  readonly senderId: string;
  readonly senderRootKeyId: string;
  readonly tenantId: string;
  readonly threadId: string;
};

export type EnvelopeHeader = EnvelopeHeaderInput & {
  readonly cipherSuite: typeof E2EE_CIPHER_SUITE;
  readonly paddedLength: number;
  readonly paddingScheme: typeof E2EE_PADDING_SCHEME;
  readonly protocol: typeof E2EE_PROTOCOL;
};

export type EncryptedEnvelope = {
  readonly ciphertext: Uint8Array;
  readonly ephemeralPublicKey: Uint8Array;
  readonly header: EnvelopeHeader;
  readonly nonce: Uint8Array;
  readonly signature: Uint8Array;
};

export type SigningKeyPair = {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
};

export type BoxKeyPair = {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
};

export type EnvelopeRandom = {
  boxKeyPair(): BoxKeyPair;
  bytes(length: number): Uint8Array;
};
