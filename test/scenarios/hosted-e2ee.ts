import { expect } from "bun:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { type RegisterAgentOutput, RegisterAgentOutputSchema } from "../../src/domain/contracts.js";
import {
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityOutputSchema,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type EncryptedMessageDto,
  type PublishAgentKeyBundleOutput,
  PublishAgentKeyBundleOutputSchema,
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
  type ResetE2eeIdentityOutput,
  ResetE2eeIdentityOutputSchema,
  type TransitionE2eeOutput,
  TransitionE2eeOutputSchema,
} from "../../src/hosted/e2ee-admin-contracts.js";
import { postgresSslOptions } from "../../src/postgres-tls.js";
import {
  createTestE2eeIdentity,
  decryptTestE2eeMessage,
  encryptTestE2eeMessage,
  type TestE2eeIdentity,
  testE2eeBundle,
} from "../support/e2ee-hosted-crypto.js";
import {
  callTool,
  callToolExpectingError,
  databaseUrl,
  initialize,
  initializeForRepository,
  post,
  testTlsConfiguration,
  toolNames,
} from "../support/hosted-mcp-harness.js";
import type { HostedTenantScenario } from "./hosted-tenant-provisioning.js";

type CountRow = { readonly count: number };
const CountRowSchema: z.ZodType<CountRow> = z.strictObject({
  count: z.coerce.number().int().nonnegative(),
});

async function waitForSessionClosed(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
): Promise<void> {
  for (let attempt: number = 0; attempt < 50; attempt += 1) {
    const response: Response = await post(url, token, sessionId, {
      id: requestId,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    if (response.status === 404) return;
    if (response.status !== 200) {
      throw new Error(`E2E state-change session closed with unexpected status ${response.status}`);
    }
    await Bun.sleep(10);
  }
  throw new Error("E2E state change did not close the prior tenant session");
}

async function assertCiphertextOnly(
  tenantId: string,
  sentinel: string,
  crossTenantId: string,
): Promise<void> {
  const configuredDatabaseUrl: string | undefined = databaseUrl;
  if (configuredDatabaseUrl === undefined) throw new Error("Hosted database URL is required");
  const database: Sql = postgres(configuredDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredDatabaseUrl, testTlsConfiguration),
  });
  try {
    await database.begin(async (transaction: TransactionSql): Promise<void> => {
      await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${tenantId}, true)`;
      const plaintextRows: unknown = await transaction`
        SELECT pg_catalog.count(*) AS count
        FROM murmur.messages
        WHERE tenant_id = ${tenantId}::uuid
      `;
      const ciphertextRows: unknown = await transaction`
        SELECT pg_catalog.count(*) AS count
        FROM murmur.e2ee_messages
        WHERE tenant_id = ${tenantId}::uuid
          AND pg_catalog.strpos(envelope_json::text, ${sentinel}) = 0
          AND pg_catalog.strpos(sender_chain_json::text, ${sentinel}) = 0
      `;
      const parsedPlaintext: CountRow | undefined = z.array(CountRowSchema).parse(plaintextRows)[0];
      const parsedCiphertext: CountRow | undefined = z
        .array(CountRowSchema)
        .parse(ciphertextRows)[0];
      expect(parsedPlaintext === undefined ? undefined : parsedPlaintext.count).toBe(0);
      expect(parsedCiphertext === undefined ? undefined : parsedCiphertext.count).toBe(1);
    });
    await database.begin(async (transaction: TransactionSql): Promise<void> => {
      await transaction`SELECT pg_catalog.set_config('murmur.tenant_id', ${crossTenantId}, true)`;
      const isolatedRows: unknown = await transaction`
        SELECT pg_catalog.count(*) AS count
        FROM murmur.e2ee_messages
        WHERE tenant_id = ${tenantId}::uuid
      `;
      const parsedIsolated: CountRow | undefined = z.array(CountRowSchema).parse(isolatedRows)[0];
      expect(parsedIsolated === undefined ? undefined : parsedIsolated.count).toBe(0);
    });
  } finally {
    await database.end({ timeout: 5 });
  }
}

export async function verifyHostedE2ee(scenario: HostedTenantScenario): Promise<void> {
  const tenant: CreateTenantOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    800,
    "create_tenant",
    { display_name: `E2E tenant ${scenario.unique}`, slug: `e2e-${scenario.unique}` },
    CreateTenantOutputSchema,
  );
  const adminToken: string = tenant.token.secret;
  let adminSession: string = await initialize(
    scenario.server.mcpUrl,
    adminToken,
    "hosted-e2ee-admin",
  );
  const initialAdminTools: readonly string[] = await toolNames(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
  );
  expect(initialAdminTools).toContain("get_e2ee_entitlement");
  expect(initialAdminTools).toContain("transition_e2ee");
  expect(
    await toolNames(scenario.server.mcpUrl, scenario.operatorToken, scenario.operatorSession),
  ).not.toContain("get_e2ee_entitlement");

  const agentToken: IssuedTokenOutput = await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    801,
    "create_access_token",
    { name: "E2E endpoints", role: "agent" },
    IssuedTokenOutputSchema,
  );
  let agentSession: string = await initialize(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    "hosted-e2ee-agents",
  );
  const aliceId: string = `e2e-alice-${scenario.unique}`;
  const bobId: string = `e2e-bob-${scenario.unique}`;
  const sourceSession: string = await initializeForRepository(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    "hosted-e2ee-source",
    "team/source",
  );
  const destinationSession: string = await initializeForRepository(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    "hosted-e2ee-destination",
    "team/destination",
  );
  for (const registration of [
    { agent_id: aliceId, machine: "machine-a", repository: "team/source", session: sourceSession },
    {
      agent_id: bobId,
      machine: "machine-b",
      repository: "team/destination",
      session: destinationSession,
    },
  ]) {
    const registered: RegisterAgentOutput = await callTool(
      scenario.server.mcpUrl,
      agentToken.token.secret,
      registration.session,
      802,
      "register_agent",
      { agent_id: registration.agent_id, metadata: { machine: registration.machine } },
      RegisterAgentOutputSchema,
    );
    expect(registered.agent.metadata).toMatchObject({
      machine: registration.machine,
      repository: registration.repository,
    });
  }
  const off: E2eeEntitlementOutput = await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    803,
    "get_e2ee_entitlement",
    {},
    E2eeEntitlementOutputSchema,
  );
  expect(off.entitlement).toMatchObject({ state: "off", unprovisioned_active_agents: 2 });

  const provisioning: TransitionE2eeOutput = await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    804,
    "transition_e2ee",
    { action: "begin_provisioning", expected_state: "off" },
    TransitionE2eeOutputSchema,
  );
  expect(provisioning).toMatchObject({ changed: true, entitlement: { state: "provisioning" } });
  await waitForSessionClosed(scenario.server.mcpUrl, adminToken, adminSession, 805);
  await waitForSessionClosed(scenario.server.mcpUrl, agentToken.token.secret, agentSession, 806);
  adminSession = await initialize(scenario.server.mcpUrl, adminToken, "hosted-e2ee-admin-2");
  agentSession = await initialize(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    "hosted-e2ee-agents-2",
  );
  expect(
    await callTool(
      scenario.server.mcpUrl,
      adminToken,
      adminSession,
      807,
      "transition_e2ee",
      { action: "begin_provisioning", expected_state: "off" },
      TransitionE2eeOutputSchema,
    ),
  ).toMatchObject({ changed: false });
  expect(await toolNames(scenario.server.mcpUrl, agentToken.token.secret, agentSession)).toContain(
    "publish_agent_key_bundle",
  );

  const now: Date = new Date();
  const alice: TestE2eeIdentity = await createTestE2eeIdentity(aliceId, now);
  const bob: TestE2eeIdentity = await createTestE2eeIdentity(bobId, now);
  for (const entry of [
    { agentId: aliceId, identity: alice },
    { agentId: bobId, identity: bob },
  ]) {
    const published: PublishAgentKeyBundleOutput = await callTool(
      scenario.server.mcpUrl,
      agentToken.token.secret,
      agentSession,
      808,
      "publish_agent_key_bundle",
      { agent_id: entry.agentId, bundle: testE2eeBundle(entry.identity) },
      PublishAgentKeyBundleOutputSchema,
    );
    expect(published.root_key_id).toBe(entry.identity.agentCertificate.rootKeyId);
  }
  const provisioned: E2eeEntitlementOutput = await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    809,
    "get_e2ee_entitlement",
    {},
    E2eeEntitlementOutputSchema,
  );
  expect(provisioned.entitlement.unprovisioned_active_agents).toBe(0);

  await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    810,
    "transition_e2ee",
    { action: "block_plaintext_writes", expected_state: "provisioning" },
    TransitionE2eeOutputSchema,
  );
  await waitForSessionClosed(scenario.server.mcpUrl, agentToken.token.secret, agentSession, 811);
  adminSession = await initialize(scenario.server.mcpUrl, adminToken, "hosted-e2ee-admin-3");
  agentSession = await initialize(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    "hosted-e2ee-agents-3",
  );
  const cutoverTools: readonly string[] = await toolNames(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    agentSession,
  );
  expect(cutoverTools).not.toContain("send_message");
  expect(cutoverTools).toContain("get_messages");
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      agentToken.token.secret,
      agentSession,
      812,
      "send_message",
      { content: "forbidden plaintext", recipient_id: bobId, sender_id: aliceId },
    ),
  ).toContain("Unknown tool");

  await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    813,
    "transition_e2ee",
    { action: "enforce", expected_state: "provisioning", trust_policy_version: 1 },
    TransitionE2eeOutputSchema,
  );
  await waitForSessionClosed(scenario.server.mcpUrl, agentToken.token.secret, agentSession, 814);
  adminSession = await initialize(scenario.server.mcpUrl, adminToken, "hosted-e2ee-admin-4");
  agentSession = await initialize(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    "hosted-e2ee-agents-4",
  );
  const enforcedTools: readonly string[] = await toolNames(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    agentSession,
  );
  expect(enforcedTools).toContain("put_encrypted_message");
  expect(enforcedTools).not.toContain("get_messages");
  expect(enforcedTools).not.toContain("send_message");
  const capability: E2eeCapabilityOutput = await callTool(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    agentSession,
    815,
    "get_e2ee_capability",
    {},
    E2eeCapabilityOutputSchema,
  );
  expect(capability).toMatchObject({
    caller_authority: "peer",
    state: "enforced",
    tenant_id: tenant.tenant.tenant_id,
  });
  const claim: ClaimEncryptionPrekeyOutput = await callTool(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    agentSession,
    816,
    "claim_encryption_prekey",
    {
      context: { branch: "production-canary", client: "codex", repository: "mattpatagon/murmur" },
      recipient_id: bobId,
      sender_id: aliceId,
    },
    ClaimEncryptionPrekeyOutputSchema,
  );
  const sentinel: string = `paid-e2ee-secret-${scenario.unique}`;
  const encryptedInput: PutEncryptedMessageInput = await encryptTestE2eeMessage({
    branch: "production-canary",
    claim,
    idempotencyKey: `hosted-e2ee-${scenario.unique}`,
    pairCounter: 1,
    plaintext: sentinel,
    recipient: bob,
    repository: "mattpatagon/murmur",
    sender: alice,
    senderId: aliceId,
    tenantId: tenant.tenant.tenant_id,
  });
  const stored: PutEncryptedMessageOutput = await callTool(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    agentSession,
    817,
    "put_encrypted_message",
    encryptedInput,
    PutEncryptedMessageOutputSchema,
  );
  expect(stored.duplicate).toBe(false);
  const inbox: EncryptedInboxOutput = await callTool(
    scenario.server.mcpUrl,
    agentToken.token.secret,
    agentSession,
    818,
    "get_encrypted_messages",
    { after_sequence: 0, agent_id: bobId, limit: 10, unread_only: false },
    EncryptedInboxOutputSchema,
  );
  expect(inbox.messages).toHaveLength(1);
  const received: EncryptedMessageDto | undefined = inbox.messages[0];
  if (received === undefined) throw new Error("Hosted encrypted message was not returned");
  expect(await decryptTestE2eeMessage(received, alice, bob)).toBe(sentinel);
  await assertCiphertextOnly(tenant.tenant.tenant_id, sentinel, scenario.tenantB.tenant.tenant_id);
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      adminToken,
      adminSession,
      819,
      "transition_e2ee",
      { action: "rollback_off", expected_state: "enforced" },
    ),
  ).toContain("ciphertext is retained");

  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      adminToken,
      adminSession,
      820,
      "reset_e2ee_identity",
      {
        agent_id: bobId,
        expected_root_key_id: alice.agentCertificate.rootKeyId,
        reason: "negative recovery root check",
      },
    ),
  ).toContain("expected E2E root does not match");
  const reset: ResetE2eeIdentityOutput = await callTool(
    scenario.server.mcpUrl,
    adminToken,
    adminSession,
    821,
    "reset_e2ee_identity",
    {
      agent_id: bobId,
      expected_root_key_id: bob.agentCertificate.rootKeyId,
      reason: "endpoint replacement after verified key loss",
    },
    ResetE2eeIdentityOutputSchema,
  );
  expect(reset.reset).toBe(true);
  await waitForSessionClosed(scenario.server.mcpUrl, adminToken, adminSession, 822);

  const tenantBSession: string = await initialize(
    scenario.server.mcpUrl,
    scenario.tenantB.token.secret,
    "hosted-e2ee-cross-tenant-admin",
  );
  expect(
    await callTool(
      scenario.server.mcpUrl,
      scenario.tenantB.token.secret,
      tenantBSession,
      823,
      "reset_e2ee_identity",
      {
        agent_id: bobId,
        expected_root_key_id: bob.agentCertificate.rootKeyId,
        reason: "cross tenant identity reset must not match",
      },
      ResetE2eeIdentityOutputSchema,
    ),
  ).toEqual({ reset: false });
  expect(
    await callToolExpectingError(
      scenario.server.mcpUrl,
      scenario.operatorToken,
      scenario.operatorSession,
      824,
      "reset_e2ee_identity",
      {
        agent_id: bobId,
        expected_root_key_id: bob.agentCertificate.rootKeyId,
        reason: "operator must not enter tenant encryption state",
      },
    ),
  ).toContain("Unknown tool");
  const audit: ListAdminAuditOutput = await callTool(
    scenario.server.mcpUrl,
    scenario.operatorToken,
    scenario.operatorSession,
    825,
    "list_admin_audit",
    { limit: 100 },
    ListAdminAuditOutputSchema,
  );
  expect(
    audit.events.some(
      (event: ListAdminAuditOutput["events"][number]): boolean =>
        event.action === "tenant_e2ee.transition" && event.target_id === tenant.tenant.tenant_id,
    ),
  ).toBe(true);
  expect(
    audit.events.some(
      (event: ListAdminAuditOutput["events"][number]): boolean =>
        event.action === "tenant_e2ee_identity.reset" && event.target_id === bobId,
    ),
  ).toBe(true);
}
