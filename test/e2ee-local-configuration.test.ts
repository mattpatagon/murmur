import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { approveExactRequest } from "../src/admin/approval-request.js";
import { AgentClient, type Clock, Instant } from "../src/domain/value-objects.js";
import {
  LocalPeersOutputSchema,
  LocalPublicExportOutputSchema,
  LocalStatusOutputSchema,
} from "../src/e2ee/local-configuration-contracts.js";
import {
  callLocalEncryptionTool,
  localEncryptionTools,
} from "../src/e2ee/local-configuration-tools.js";
import { CreateLocalTrustPolicyOutputSchema } from "../src/e2ee/local-trust-authoring.js";
import { LocalE2eeVault } from "../src/e2ee/local-vault.js";
import type { StoredAgentKey, StoredRootKey } from "../src/e2ee/local-vault-rows.js";
import { E2eeProxyApplication } from "../src/e2ee/proxy-application.js";
import { E2eeProxyService } from "../src/e2ee/proxy-service.js";
import {
  parseSerializedTrustPolicy,
  verifyOrganizationTrustPolicy,
} from "../src/e2ee/trust-policy.js";
import type {
  PublishAgentKeyBundleInput,
  PublishAgentKeyBundleOutput,
} from "../src/e2ee/wire-tools.js";
import { MemoryE2eeBackend, MemoryE2eeRemote } from "./support/e2ee-memory-remote.js";

const AGENT_ID: string = "test:codex:repo:local";
const NOW: string = "2026-08-10T20:00:00.000Z";
const ROOT_ID: string = `mrk_${"A".repeat(43)}`;

class TestClock implements Clock {
  public instant: Instant = Instant.parse(NOW);
  public now(): Instant {
    return this.instant;
  }
}

class PublicationRemote extends MemoryE2eeRemote {
  public failPublication: boolean = false;
  public override async publishAgentKeyBundle(
    input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    if (this.failPublication) throw new Error("secret backend failure");
    return await super.publishAgentKeyBundle(input);
  }
}

type Approval = { readonly name: string; readonly input: unknown };
type Fixture = {
  readonly backend: MemoryE2eeBackend;
  readonly call: (name: string, input: Record<string, unknown>) => Promise<CallToolResult>;
  readonly client: Client;
  readonly clock: TestClock;
  readonly remote: PublicationRemote;
  readonly service: E2eeProxyService;
  readonly vault: LocalE2eeVault;
  approval: Approval | null;
};

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  forms: boolean = true,
): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-local-config-"));
  const vault: LocalE2eeVault = new LocalE2eeVault(join(directory, "vault.sqlite"));
  const backend: MemoryE2eeBackend = new MemoryE2eeBackend();
  const remote: PublicationRemote = new PublicationRemote(backend);
  const clock: TestClock = new TestClock();
  const service: E2eeProxyService = new E2eeProxyService({
    branchName: null,
    client: AgentClient.parse("codex"),
    clock,
    remote,
    repositoryName: null,
    trustOnFirstUse: false,
    vault,
  });
  const app: E2eeProxyApplication = new E2eeProxyApplication(service);
  const client: Client = new Client(
    { name: "local-config-test", version: "1.0.0" },
    { capabilities: forms ? { elicitation: { form: {} } } : {} },
  );
  const fixture: Fixture = {
    approval: null,
    backend,
    client,
    clock,
    remote,
    service,
    vault,
    call: async (name: string, input: Record<string, unknown>): Promise<CallToolResult> =>
      CallToolResultSchema.parse(
        await client.callTool({ arguments: input, name }, CallToolResultSchema),
      ),
  };
  if (forms) {
    client.setRequestHandler(
      ElicitRequestSchema,
      async (request: ElicitRequest): Promise<ElicitResult> => {
        const approval: Approval | null = fixture.approval;
        fixture.approval = null;
        return approval === null
          ? { action: "decline" }
          : approveExactRequest(request, approval.name, approval.input);
      },
    );
  }
  const [clientTransport, serverTransport]: [InMemoryTransport, InMemoryTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    vault.settings.bindActiveTenant(backend.capability().tenant_id, NOW);
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(fixture);
  } finally {
    await client.close();
    await app.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function localAgent(vault: LocalE2eeVault): StoredAgentKey {
  const agent: StoredAgentKey | null = vault.keys.getAgent(AGENT_ID);
  if (agent === null) throw new Error("Expected initialized fixture agent");
  return agent;
}

test("discovers local configuration and setup tools; reads public state without creating keys", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    const names: readonly string[] = (await fixture.client.listTools()).tools.map(
      (tool: Tool): string => tool.name,
    );
    expect(names).toContain("get_setup_guide");
    for (const tool of localEncryptionTools()) expect(names).toContain(tool.name);
    expect(
      LocalStatusOutputSchema.parse(
        (await fixture.call("e2ee_local_status", {})).structuredContent,
      ),
    ).toMatchObject({
      initialized: false,
      root_key_id: null,
      active_tenant_id: fixture.backend.capability().tenant_id,
    });
    expect((await fixture.call("e2ee_local_fingerprint", {})).isError).toBe(true);
    expect((await fixture.call("e2ee_local_export_public", { agent_id: AGENT_ID })).isError).toBe(
      true,
    );
    expect(
      (await fixture.call("e2ee_local_replenish_prekeys", { agent_id: AGENT_ID })).isError,
    ).toBe(true);
    expect(fixture.vault.keys.getRoot()).toBeNull();
    expect(
      await callLocalEncryptionTool("unknown", {}, fixture.service.localEncryption),
    ).toBeNull();
    expect(await callLocalEncryptionTool("e2ee_local_status", {}, undefined)).toBeNull();
    expect((await fixture.call("get_setup_guide", { topic: "encryption" })).isError).not.toBe(true);
  });
});

test("trust requires exact host approval, rejects tenant selection and preserves existing pins", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    const input: Record<string, unknown> = { agent_id: AGENT_ID, root_key_id: ROOT_ID };
    expect((await fixture.call("e2ee_local_trust_peer", input)).isError).toBe(true);
    fixture.approval = {
      input: { ...input, root_key_id: `mrk_${"B".repeat(43)}` },
      name: "e2ee_local_trust_peer",
    };
    expect((await fixture.call("e2ee_local_trust_peer", input)).isError).toBe(true);
    fixture.approval = { input, name: "e2ee_local_trust_peer" };
    expect(
      (
        await fixture.call("e2ee_local_trust_peer", {
          ...input,
          tenant_id: fixture.backend.capability().tenant_id,
        })
      ).isError,
    ).toBe(true);
    expect((await fixture.call("e2ee_local_trust_peer", input)).isError).not.toBe(true);
    const peers: ReturnType<typeof LocalPeersOutputSchema.parse> = LocalPeersOutputSchema.parse(
      (await fixture.call("e2ee_local_peers", { limit: 1 })).structuredContent,
    );
    expect(peers.peers).toHaveLength(1);
    expect(peers.peers[0]).toMatchObject({
      root_key_id: ROOT_ID,
      tenant_id: fixture.backend.capability().tenant_id,
      verification: "pending_strict",
    });
    expect(
      LocalPeersOutputSchema.parse(
        (await fixture.call("e2ee_local_peers", { offset: 1 })).structuredContent,
      ).peers,
    ).toEqual([]);
    const replacement: Record<string, unknown> = { ...input, root_key_id: `mrk_${"B".repeat(43)}` };
    fixture.approval = { input: replacement, name: "e2ee_local_trust_peer" };
    expect((await fixture.call("e2ee_local_trust_peer", replacement)).isError).toBe(true);
    expect((await fixture.call("e2ee_local_peers", { limit: 101 })).isError).toBe(true);
    expect((await fixture.call("e2ee_local_status", { extra: "forbidden" })).isError).toBe(true);
    expect(fixture.backend.captures).toEqual([]);
  });
});

test("security changes fail closed without host elicitation or an injected approval boundary", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    const input: Record<string, unknown> = { agent_id: AGENT_ID, root_key_id: ROOT_ID };
    expect((await fixture.call("e2ee_local_trust_peer", input)).isError).toBe(true);
    await expect(
      callLocalEncryptionTool("e2ee_local_trust_peer", input, fixture.service.localEncryption),
    ).rejects.toThrow("human approval");
    expect(fixture.vault.keys.listExpectedPeerRoots()).toEqual([]);
  }, false);
});

test("rotates and revokes guarded local keys, publishes changes and never exports private material", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    expect((await fixture.call("register_agent", { agent_id: AGENT_ID })).isError).not.toBe(true);
    const original: StoredAgentKey = localAgent(fixture.vault);
    fixture.clock.instant = fixture.clock.instant.addDays(1);
    const rotation: Record<string, unknown> = {
      agent_id: AGENT_ID,
      expected_agent_key_id: original.certificate.signingKeyId,
    };
    fixture.approval = { input: rotation, name: "e2ee_local_rotate_agent_key" };
    expect((await fixture.call("e2ee_local_rotate_agent_key", rotation)).isError).not.toBe(true);
    const rotated: StoredAgentKey = localAgent(fixture.vault);
    expect(rotated.certificate.signingKeyId).not.toBe(original.certificate.signingKeyId);
    fixture.approval = { input: rotation, name: "e2ee_local_rotate_agent_key" };
    expect((await fixture.call("e2ee_local_rotate_agent_key", rotation)).isError).toBe(true);
    fixture.clock.instant = fixture.clock.instant.addDays(1);
    const revocation: Record<string, unknown> = {
      agent_id: AGENT_ID,
      expected_agent_key_id: rotated.certificate.signingKeyId,
      reason: "Key replacement requested",
    };
    fixture.approval = { input: revocation, name: "e2ee_local_revoke_agent_key" };
    expect((await fixture.call("e2ee_local_revoke_agent_key", revocation)).isError).not.toBe(true);
    const current: StoredAgentKey = localAgent(fixture.vault);
    expect(current.certificate.signingKeyId).not.toBe(rotated.certificate.signingKeyId);
    expect(
      (await fixture.call("e2ee_local_replenish_prekeys", { agent_id: AGENT_ID })).isError,
    ).not.toBe(true);
    const exported: ReturnType<typeof LocalPublicExportOutputSchema.parse> =
      LocalPublicExportOutputSchema.parse(
        (await fixture.call("e2ee_local_export_public", { agent_id: AGENT_ID })).structuredContent,
      );
    expect(exported.agents).toHaveLength(1);
    expect(exported.agents[0]).toMatchObject({
      agent_key_revocations: [{ revoked_signing_key_id: rotated.certificate.signingKeyId }],
    });
    const root: StoredRootKey | null = fixture.vault.keys.getRoot();
    if (root === null) throw new Error("Expected local root");
    const outputs: string = JSON.stringify({ captures: fixture.backend.captures, exported });
    for (const key of [
      root.privateKey,
      original.privateKey,
      rotated.privateKey,
      current.privateKey,
    ]) {
      expect(outputs).not.toContain(Buffer.from(key).toString("base64url"));
    }
    expect(outputs).not.toContain("private_key");
    expect((await fixture.call("e2ee_local_fingerprint", {})).structuredContent).toEqual({
      root_key_id: root.rootKeyId,
    });
  });
});

test("publication failure retains safe local changes and supports a non-rotating retry", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    await fixture.call("register_agent", { agent_id: AGENT_ID });
    const original: StoredAgentKey = localAgent(fixture.vault);
    fixture.clock.instant = fixture.clock.instant.addDays(1);
    fixture.remote.failPublication = true;
    const input: Record<string, unknown> = {
      agent_id: AGENT_ID,
      expected_agent_key_id: original.certificate.signingKeyId,
    };
    fixture.approval = { input, name: "e2ee_local_rotate_agent_key" };
    const failed: CallToolResult = await fixture.call("e2ee_local_rotate_agent_key", input);
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain("e2ee_local_replenish_prekeys");
    expect(JSON.stringify(failed)).not.toContain("secret backend failure");
    const rotatedId: string = localAgent(fixture.vault).certificate.signingKeyId;
    expect(rotatedId).not.toBe(original.certificate.signingKeyId);
    fixture.remote.failPublication = false;
    expect(
      (await fixture.call("e2ee_local_replenish_prekeys", { agent_id: AGENT_ID })).isError,
    ).not.toBe(true);
    expect(localAgent(fixture.vault).certificate.signingKeyId).toBe(rotatedId);
  });
});

test("authors and imports signed tenant policies entirely through MCP with verified issuer continuity", async (): Promise<void> => {
  await withFixture(async (fixture: Fixture): Promise<void> => {
    await fixture.call("register_agent", { agent_id: AGENT_ID });
    const root: StoredRootKey | null = fixture.vault.keys.getRoot();
    if (root === null) throw new Error("Expected local root");
    const input: Record<string, unknown> = {
      bindings: [
        {
          agent_id: AGENT_ID,
          root_key_id: root.rootKeyId,
          root_public_key: Buffer.from(root.publicKey).toString("base64url"),
        },
      ],
      revocations: [],
      validity_days: 30,
      version: 1,
    };
    expect((await fixture.call("e2ee_local_create_trust_policy", input)).isError).toBe(true);
    fixture.approval = { input, name: "e2ee_local_create_trust_policy" };
    const created: ReturnType<typeof CreateLocalTrustPolicyOutputSchema.parse> =
      CreateLocalTrustPolicyOutputSchema.parse(
        (await fixture.call("e2ee_local_create_trust_policy", input)).structuredContent,
      );
    await verifyOrganizationTrustPolicy(
      parseSerializedTrustPolicy(created.policy_json),
      created.issuer_key_id,
      new Date(NOW),
    );
    expect(created.policy_json).not.toContain(Buffer.from(root.privateKey).toString("base64url"));
    expect(fixture.vault.trust.getPolicyState(created.tenant_id)).toBeNull();
    const missingIssuer: Record<string, unknown> = { policy_json: created.policy_json };
    fixture.approval = { input: missingIssuer, name: "e2ee_local_import_trust_policy" };
    expect((await fixture.call("e2ee_local_import_trust_policy", missingIssuer)).isError).toBe(
      true,
    );
    const importInput: Record<string, unknown> = {
      ...missingIssuer,
      issuer_key_id: created.issuer_key_id,
    };
    fixture.approval = { input: importInput, name: "e2ee_local_import_trust_policy" };
    expect((await fixture.call("e2ee_local_import_trust_policy", importInput)).isError).not.toBe(
      true,
    );
    expect(fixture.vault.trust.getPolicyState(created.tenant_id)).toMatchObject({ version: 1 });
    const secondInput: Record<string, unknown> = { ...input, version: 2 };
    fixture.approval = { input: secondInput, name: "e2ee_local_create_trust_policy" };
    const second: ReturnType<typeof CreateLocalTrustPolicyOutputSchema.parse> =
      CreateLocalTrustPolicyOutputSchema.parse(
        (await fixture.call("e2ee_local_create_trust_policy", secondInput)).structuredContent,
      );
    const update: Record<string, unknown> = { policy_json: second.policy_json };
    fixture.approval = { input: update, name: "e2ee_local_import_trust_policy" };
    expect((await fixture.call("e2ee_local_import_trust_policy", update)).isError).not.toBe(true);
    fixture.approval = { input: importInput, name: "e2ee_local_import_trust_policy" };
    expect((await fixture.call("e2ee_local_import_trust_policy", importInput)).isError).toBe(true);
    const crossTenant: Record<string, unknown> = {
      issuer_key_id: created.issuer_key_id,
      policy_json: created.policy_json.replace(
        created.tenant_id,
        "11111111-1111-4111-8111-111111111111",
      ),
    };
    fixture.approval = { input: crossTenant, name: "e2ee_local_import_trust_policy" };
    expect((await fixture.call("e2ee_local_import_trust_policy", crossTenant)).isError).toBe(true);
    expect(
      (await fixture.call("e2ee_local_create_trust_policy", { ...input, validity_days: 91 }))
        .isError,
    ).toBe(true);
  });
});
