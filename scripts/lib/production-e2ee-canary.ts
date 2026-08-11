import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { PrekeyCertificateDto } from "../../src/e2ee/wire-contracts.js";
import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityOutputSchema,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type EncryptedMessageDto,
  type PutEncryptedMessageInput,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
} from "../../src/e2ee/wire-tools.js";
import {
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListAdminAuditOutput,
  ListAdminAuditOutputSchema,
} from "../../src/hosted/contracts.js";
import {
  type E2eeEntitlementOutput,
  E2eeEntitlementOutputSchema,
  TransitionE2eeOutputSchema,
} from "../../src/hosted/e2ee-admin-contracts.js";
import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  decryptCanaryE2eeMessage,
  encryptCanaryE2eeMessage,
} from "./e2ee-canary-crypto.js";
import {
  assertCondition as assert,
  callProductionTool as call,
  callProductionToolExpectingError as callExpectingError,
  closeProductionHarnesses as closeAll,
  connectProductionHarness as connect,
  ensureTenantSuspended,
  findTenantBySlug,
  type ProductionHarness as Harness,
  productionToolNames as toolNames,
} from "./production-hosted-harness.js";

export type ProductionE2eeCanaryResult = {
  readonly ciphertext_only_tool_matrix: true;
  readonly cross_repository_delivery: true;
  readonly decrypted_at_recipient: true;
  readonly independent_signature_verified: true;
  readonly plaintext_fallback_rejected: true;
  readonly tenant_id: string;
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

type CanaryState = {
  readonly adminSecret: string;
  readonly receiverSecret: string;
  readonly senderSecret: string;
  readonly tenantId: string;
};

type ConnectedEndpoints = {
  readonly admin: Harness;
  readonly receiver: Harness;
  readonly sender: Harness;
};

async function createCanaryState(
  operator: Harness,
  url: URL,
  unique: string,
  tenantSlug: string,
  harnesses: Harness[],
): Promise<CanaryState> {
  const created: CreateTenantOutput = CreateTenantOutputSchema.parse(
    await call(operator, "create_tenant", {
      display_name: `Production E2E canary ${unique}`,
      slug: tenantSlug,
    }),
  );
  const admin: Harness = await connect(url, created.token.secret, `live-e2ee-admin-${unique}`);
  harnesses.push(admin);
  const adminTools: readonly string[] = await toolNames(admin);
  assert(adminTools.includes("transition_e2ee"), "Tenant admin cannot transition E2E state");
  assert(adminTools.includes("reset_e2ee_identity"), "Tenant admin cannot recover E2E identity");

  const senderToken: IssuedTokenOutput = IssuedTokenOutputSchema.parse(
    await call(admin, "create_access_token", {
      name: "Production E2E source",
      repository: "canary/source",
      role: "agent",
    }),
  );
  const receiverToken: IssuedTokenOutput = IssuedTokenOutputSchema.parse(
    await call(admin, "create_access_token", {
      name: "Production E2E destination",
      repository: "canary/destination",
      role: "agent",
    }),
  );
  return {
    adminSecret: created.token.secret,
    receiverSecret: receiverToken.token.secret,
    senderSecret: senderToken.token.secret,
    tenantId: created.tenant.tenant_id,
  };
}

async function connectEndpoints(
  url: URL,
  state: CanaryState,
  unique: string,
  phase: string,
  harnesses: Harness[],
): Promise<ConnectedEndpoints> {
  const admin: Harness = await connect(
    url,
    state.adminSecret,
    `live-e2ee-admin-${phase}-${unique}`,
  );
  const sender: Harness = await connect(
    url,
    state.senderSecret,
    `live-e2ee-source-${phase}-${unique}`,
    "codex",
    "canary/source",
  );
  const receiver: Harness = await connect(
    url,
    state.receiverSecret,
    `live-e2ee-destination-${phase}-${unique}`,
    "claude",
    "canary/destination",
  );
  harnesses.push(admin, sender, receiver);
  return { admin, receiver, sender };
}

async function publishIdentity(
  endpoint: Harness,
  agentId: string,
  identity: CanaryE2eeIdentity,
): Promise<void> {
  const published: Record<string, unknown> = await call(endpoint, "publish_agent_key_bundle", {
    agent_id: agentId,
    bundle: canaryE2eeBundle(identity),
  });
  assert(
    published["root_key_id"] === identity.agentCertificate.rootKeyId,
    "Published E2E root was not acknowledged",
  );
}

function claimedPrekey(claim: ClaimEncryptionPrekeyOutput): PrekeyCertificateDto {
  if (claim.prekey_class === "fallback") return claim.bundle.fallback_prekey;
  const certificate: PrekeyCertificateDto | undefined = claim.bundle.one_time_prekeys.find(
    (candidate: PrekeyCertificateDto): boolean => candidate.prekey_id === claim.prekey_id,
  );
  if (certificate === undefined) throw new Error("Production E2E claim omitted its prekey");
  return certificate;
}

async function independentlyVerifyLiveEnvelope(
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
    assert(
      verified.message_id === message.envelope.header.message_id,
      "Independent verifier returned a different production message",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function executeEncryptedDelivery(
  endpoints: ConnectedEndpoints,
  state: CanaryState,
  unique: string,
  senderId: string,
  receiverId: string,
  senderIdentity: CanaryE2eeIdentity,
  receiverIdentity: CanaryE2eeIdentity,
): Promise<void> {
  const senderTools: readonly string[] = await toolNames(endpoints.sender);
  assert(senderTools.includes("put_encrypted_message"), "Encrypted send tool is absent");
  assert(!senderTools.includes("send_message"), "Plaintext send tool survived E2E enforcement");
  assert(!senderTools.includes("get_messages"), "Plaintext inbox survived E2E enforcement");

  const capability: E2eeCapabilityOutput = E2eeCapabilityOutputSchema.parse(
    await call(endpoints.sender, "get_e2ee_capability", {}),
  );
  assert(capability.state === "enforced", "Production tenant did not enforce E2E");
  assert(capability.tenant_id === state.tenantId, "E2E capability crossed tenants");
  assert(capability.caller_authority === "peer", "Agent acquired orchestrator authority");

  const claim: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
    await call(endpoints.sender, "claim_encryption_prekey", {
      context: {
        branch: "production-canary",
        client: "codex",
        repository: "canary/source",
      },
      recipient_id: receiverId,
      sender_id: senderId,
    }),
  );
  const sentinel: string = `paid-e2ee-production-secret-${unique}`;
  const encryptedInput: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
    claim,
    idempotencyKey: `production-e2ee-${unique}`,
    pairCounter: 1,
    plaintext: sentinel,
    recipient: receiverIdentity,
    repository: "canary/source",
    sender: senderIdentity,
    senderId,
    tenantId: state.tenantId,
  });
  assert(
    !JSON.stringify(encryptedInput).includes(sentinel),
    "Plaintext appeared in the production encrypted request",
  );
  const stored: PutEncryptedMessageOutput = PutEncryptedMessageOutputSchema.parse(
    await call(endpoints.sender, "put_encrypted_message", encryptedInput),
  );
  assert(!stored.duplicate, "Production encrypted delivery was unexpectedly a duplicate");
  const inbox: EncryptedInboxOutput = EncryptedInboxOutputSchema.parse(
    await call(endpoints.receiver, "get_encrypted_messages", {
      after_sequence: 0,
      agent_id: receiverId,
      limit: 10,
      unread_only: false,
    }),
  );
  const received: EncryptedMessageDto | undefined = inbox.messages[0];
  assert(received !== undefined && inbox.messages.length === 1, "Encrypted inbox is incomplete");
  await independentlyVerifyLiveEnvelope(received, claim);
  assert(
    (await decryptCanaryE2eeMessage(received, senderIdentity, receiverIdentity)) === sentinel,
    "Recipient could not decrypt the production sentinel",
  );
  const plaintextError: string = await callExpectingError(endpoints.sender, "send_message", {
    content: "production plaintext fallback must fail",
    recipient_id: receiverId,
    sender_id: senderId,
  });
  assert(plaintextError.includes("Unknown tool"), "Production accepted plaintext fallback");
  const rollbackError: string = await callExpectingError(endpoints.admin, "transition_e2ee", {
    action: "rollback_off",
    expected_state: "enforced",
  });
  assert(rollbackError.includes("ciphertext is retained"), "Ciphertext rollback guard failed");
}

async function verifyAudit(operator: Harness, tenantId: string): Promise<void> {
  const audit: ListAdminAuditOutput = ListAdminAuditOutputSchema.parse(
    await call(operator, "list_admin_audit", { limit: 500 }),
  );
  const transitions: number = audit.events.filter(
    (event: ListAdminAuditOutput["events"][number]): boolean =>
      event.action === "tenant_e2ee.transition" && event.target_id === tenantId,
  ).length;
  assert(transitions === 3, "Production E2E audit trail omitted a cutover transition");
}

export async function runProductionE2eeCanary(
  operator: Harness,
  url: URL,
  unique: string,
): Promise<ProductionE2eeCanaryResult> {
  const tenantSlug: string = `production-e2ee-${unique}`;
  const senderId: string = `live-e2ee-source-${unique}`;
  const receiverId: string = `live-e2ee-destination-${unique}`;
  const harnesses: Harness[] = [];
  let tenantId: string | null = null;
  let result: ProductionE2eeCanaryResult | null = null;
  let operationError: unknown;
  let failed: boolean = false;
  const cleanupErrors: string[] = [];
  try {
    const operatorTools: readonly string[] = await toolNames(operator);
    assert(!operatorTools.includes("transition_e2ee"), "Operator can transition tenant E2E state");
    const state: CanaryState = await createCanaryState(
      operator,
      url,
      unique,
      tenantSlug,
      harnesses,
    );
    tenantId = state.tenantId;
    const initial: ConnectedEndpoints = await connectEndpoints(
      url,
      state,
      unique,
      "initial",
      harnesses,
    );
    await call(initial.sender, "register_agent", {
      agent_id: senderId,
      metadata: { machine: "production-machine-source" },
    });
    await call(initial.receiver, "register_agent", {
      agent_id: receiverId,
      metadata: { machine: "production-machine-destination" },
    });
    const off: E2eeEntitlementOutput = E2eeEntitlementOutputSchema.parse(
      await call(initial.admin, "get_e2ee_entitlement", {}),
    );
    assert(
      off.entitlement.state === "off" && off.entitlement.unprovisioned_active_agents === 2,
      "Production E2E prerequisites did not detect active endpoints",
    );
    TransitionE2eeOutputSchema.parse(
      await call(initial.admin, "transition_e2ee", {
        action: "begin_provisioning",
        expected_state: "off",
      }),
    );

    const provisioning: ConnectedEndpoints = await connectEndpoints(
      url,
      state,
      unique,
      "provisioning",
      harnesses,
    );
    const now: Date = new Date();
    const senderIdentity: CanaryE2eeIdentity = await createCanaryE2eeIdentity(senderId, now);
    const receiverIdentity: CanaryE2eeIdentity = await createCanaryE2eeIdentity(receiverId, now);
    await publishIdentity(provisioning.sender, senderId, senderIdentity);
    await publishIdentity(provisioning.receiver, receiverId, receiverIdentity);
    const ready: E2eeEntitlementOutput = E2eeEntitlementOutputSchema.parse(
      await call(provisioning.admin, "get_e2ee_entitlement", {}),
    );
    assert(ready.entitlement.unprovisioned_active_agents === 0, "Endpoint keys are incomplete");
    TransitionE2eeOutputSchema.parse(
      await call(provisioning.admin, "transition_e2ee", {
        action: "block_plaintext_writes",
        expected_state: "provisioning",
      }),
    );

    const blocked: ConnectedEndpoints = await connectEndpoints(
      url,
      state,
      unique,
      "blocked",
      harnesses,
    );
    assert(!(await toolNames(blocked.sender)).includes("send_message"), "Write block was ignored");
    TransitionE2eeOutputSchema.parse(
      await call(blocked.admin, "transition_e2ee", {
        action: "enforce",
        expected_state: "provisioning",
        trust_policy_version: 1,
      }),
    );
    const enforced: ConnectedEndpoints = await connectEndpoints(
      url,
      state,
      unique,
      "enforced",
      harnesses,
    );
    await executeEncryptedDelivery(
      enforced,
      state,
      unique,
      senderId,
      receiverId,
      senderIdentity,
      receiverIdentity,
    );
    const operatorReset: string = await callExpectingError(operator, "reset_e2ee_identity", {
      agent_id: receiverId,
      expected_root_key_id: receiverIdentity.agentCertificate.rootKeyId,
      reason: "production operator must not recover tenant identity",
    });
    assert(operatorReset.includes("Unknown tool"), "Operator entered tenant encryption state");
    await verifyAudit(operator, state.tenantId);
    result = {
      ciphertext_only_tool_matrix: true,
      cross_repository_delivery: true,
      decrypted_at_recipient: true,
      independent_signature_verified: true,
      plaintext_fallback_rejected: true,
      tenant_id: state.tenantId,
    };
  } catch (error: unknown) {
    failed = true;
    operationError = error;
  } finally {
    if (tenantId === null) {
      try {
        const recovered: Record<string, unknown> | null = await findTenantBySlug(
          operator,
          tenantSlug,
        );
        if (recovered !== null && typeof recovered["tenant_id"] === "string") {
          tenantId = recovered["tenant_id"];
        }
      } catch (_error: unknown) {
        cleanupErrors.push(`could not recover ${tenantSlug}`);
      }
    }
    if (tenantId !== null) {
      try {
        await ensureTenantSuspended(operator, tenantId, tenantSlug);
      } catch (_error: unknown) {
        cleanupErrors.push(`could not suspend ${tenantSlug} (${tenantId})`);
      }
    }
    await closeAll(harnesses);
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`Production E2E cleanup failed: ${cleanupErrors.join("; ")}`);
  }
  if (failed) throw operationError;
  if (result === null) throw new Error("Production E2E canary produced no result");
  return result;
}
