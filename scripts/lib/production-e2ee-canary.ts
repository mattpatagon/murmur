import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityOutputSchema,
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
  type CreateOrchestratorTokenOutput,
  CreateOrchestratorTokenOutputSchema,
  type SetOrchestratorPolicyOutput,
  SetOrchestratorPolicyOutputSchema,
} from "../../src/hosted/orchestration-contracts.js";
import {
  type CanaryE2eeIdentity,
  canaryE2eeBundle,
  createCanaryE2eeIdentity,
  decryptCanaryE2eeMessage,
  encryptCanaryE2eeMessage,
} from "./e2ee-canary-crypto.js";
import { executeProductionEncryptedBroadcast } from "./production-e2ee-broadcast-canary.js";
import {
  type ProductionE2eeCanaryState as CanaryState,
  type ProductionE2eeEndpoints as ConnectedEndpoints,
  independentlyVerifyLiveEnvelope,
  liveEncryptedMessage,
} from "./production-e2ee-canary-support.js";
import { executeProductionEncryptedOrchestration } from "./production-e2ee-orchestration-canary.js";
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
  readonly encrypted_broadcast_fanout: true;
  readonly encrypted_orchestrator_round_trip: true;
  readonly independent_signature_verified: true;
  readonly plaintext_fallback_rejected: true;
  readonly tenant_id: string;
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
  const orchestratorToken: CreateOrchestratorTokenOutput =
    CreateOrchestratorTokenOutputSchema.parse(
      await call(admin, "create_orchestrator_token", {
        agent_id: `live-e2ee-orchestrator-${unique}`,
        name: "Production E2E orchestrator",
        repository: "canary/orchestrator",
      }),
    );
  return {
    adminSecret: created.token.secret,
    orchestratorKeyId: orchestratorToken.token.key_id,
    orchestratorSecret: orchestratorToken.token.secret,
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
  const orchestrator: Harness = await connect(
    url,
    state.orchestratorSecret,
    `live-e2ee-orchestrator-${phase}-${unique}`,
    "codex",
    "canary/orchestrator",
  );
  harnesses.push(admin, sender, receiver, orchestrator);
  return { admin, orchestrator, receiver, sender };
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
  const received: EncryptedMessageDto = await liveEncryptedMessage(
    endpoints.receiver,
    receiverId,
    encryptedInput.envelope.header.message_id,
  );
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
  const orchestratorId: string = `live-e2ee-orchestrator-${unique}`;
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
    await call(initial.orchestrator, "register_agent", {
      agent_id: orchestratorId,
      metadata: { machine: "production-machine-orchestrator" },
    });
    const off: E2eeEntitlementOutput = E2eeEntitlementOutputSchema.parse(
      await call(initial.admin, "get_e2ee_entitlement", {}),
    );
    assert(
      off.entitlement.state === "off" && off.entitlement.unprovisioned_active_agents === 3,
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
    const orchestratorIdentity: CanaryE2eeIdentity = await createCanaryE2eeIdentity(
      orchestratorId,
      now,
    );
    await publishIdentity(provisioning.sender, senderId, senderIdentity);
    await publishIdentity(provisioning.receiver, receiverId, receiverIdentity);
    await publishIdentity(provisioning.orchestrator, orchestratorId, orchestratorIdentity);
    const policy: SetOrchestratorPolicyOutput = SetOrchestratorPolicyOutputSchema.parse(
      await call(provisioning.admin, "set_orchestrator_policy", {
        instructions: "Answer the encrypted production canary and preserve its thread.",
        orchestrator_key_id: state.orchestratorKeyId,
        repository: "canary/source",
        scope_kind: "organization",
      }),
    );
    assert(
      policy.policy.agent_id === orchestratorId,
      "Production orchestrator policy crossed agents",
    );
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
    await executeProductionEncryptedBroadcast({
      endpoints: enforced,
      orchestratorId,
      orchestratorIdentity,
      receiverId,
      receiverIdentity,
      senderId,
      senderIdentity,
      state,
      unique,
    });
    await executeProductionEncryptedOrchestration({
      endpoints: enforced,
      orchestratorId,
      orchestratorIdentity,
      policyId: policy.policy.policy_id,
      senderId,
      senderIdentity,
      state,
      unique,
    });
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
      encrypted_broadcast_fanout: true,
      encrypted_orchestrator_round_trip: true,
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
