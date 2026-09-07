import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { OrchestratorPolicyId, PersonalId } from "../src/domain/orchestration.js";
import {
  AgentId,
  Instant,
  MachineName,
  RepositoryName,
  TenantId,
} from "../src/domain/value-objects.js";
import { type IssuedTokenDto, IssuedTokenOutputSchema } from "../src/hosted/contracts.js";
import type {
  EffectiveOrchestrator,
  HostedControlPlane,
  IssuedToken,
  OrchestratorPolicy,
  OrchestratorScope,
  TenantPrincipal,
} from "../src/hosted/control-plane.js";
import {
  ClearOrchestratorPolicyOutputSchema,
  type GetOrchestratorOutput,
  GetOrchestratorOutputSchema,
  type SetOrchestratorPolicyOutput,
  SetOrchestratorPolicyOutputSchema,
} from "../src/hosted/orchestration-contracts.js";
import { type AdminToolContext, callTenantAdminTool } from "../src/mcp/murmur-admin-tools.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import {
  callOrchestrationTool,
  type OrchestrationToolContext,
} from "../src/mcp/murmur-orchestration-tools.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

const TENANT_ID: TenantId = TenantId.parse("10000000-0000-4000-8000-000000000001");
const PERSONAL_ID: PersonalId = PersonalId.parse("20000000-0000-4000-8000-000000000001");
const POLICY_ID: string = "30000000-0000-4000-8000-000000000001";
const TOKEN_ID: string = "40000000-0000-4000-8000-000000000001";
const NOW: Instant = Instant.parse("2026-09-07T20:00:00.000Z");

function principal(machineName: MachineName): TenantPrincipal {
  return {
    kind: "tenant",
    machineName,
    personalId: PERSONAL_ID,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    role: "tenant_admin",
    tenantId: TENANT_ID,
    tokenId: TOKEN_ID,
  };
}

function issuedToken(machineName: MachineName | null, agentId: AgentId | null): IssuedToken {
  return {
    agentId,
    expiresAt: null,
    keyId: "machine_token_key",
    machineName,
    name: "Machine-bound token",
    personalId: PERSONAL_ID,
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    role: agentId === null ? "agent" : "orchestrator",
    secret: `mur_machine_token_key_${"A".repeat(43)}`,
    tenantId: TENANT_ID,
    tokenId: TOKEN_ID,
  };
}

function policy(scope: OrchestratorScope): OrchestratorPolicy {
  return {
    createdAt: NOW,
    createdByTokenId: TOKEN_ID,
    enabled: true,
    instructions: "Decide routine coordination and escalate security changes.",
    orchestratorAgentId: AgentId.parse("machine-boss"),
    orchestratorTokenId: TOKEN_ID,
    policyId: OrchestratorPolicyId.parse(POLICY_ID),
    scope,
    updatedAt: NOW,
    updatedByTokenId: TOKEN_ID,
  };
}

function emptyControlPlane(): HostedControlPlane {
  return Object.create(null);
}

function adminContext(controlPlane: HostedControlPlane): AdminToolContext {
  return {
    controlPlane,
    legacyCredentialHash: null,
    onE2eeStateChanged: null,
    onTenantSuspended: null,
    onTokenRevoked: null,
    tenantOnboardingEnabled: false,
  };
}

function orchestrationContext(
  controlPlane: HostedControlPlane,
  authenticatedPrincipal: TenantPrincipal,
): OrchestrationToolContext {
  return {
    branchName: null,
    client: null,
    controlPlane,
    principal: authenticatedPrincipal,
    repositoryName: null,
  };
}

function requireResult(result: CallToolResult | null): CallToolResult {
  if (result === null) throw new Error("Expected an MCP tool result");
  return result;
}

describe("machine-qualified orchestration MCP routing", (): void => {
  test("passes machine bindings from access and orchestrator token inputs", async (): Promise<void> => {
    const controlPlane: HostedControlPlane = emptyControlPlane();
    const authenticatedPrincipal: TenantPrincipal = principal(MachineName.parse("admin-host"));
    const accessMachines: Array<MachineName | null> = [];
    const orchestratorMachines: Array<MachineName | null> = [];
    controlPlane.createToken = async (
      _principal: TenantPrincipal,
      _role: "agent" | "orchestrator" | "tenant_admin",
      _name: string,
      _expiresAt: Instant | null,
      _personalId: PersonalId | null,
      _repositoryName: RepositoryName | null,
      machineName: MachineName | null,
    ): Promise<IssuedToken> => {
      accessMachines.push(machineName);
      return issuedToken(machineName, null);
    };
    controlPlane.createOrchestratorToken = async (
      _principal: TenantPrincipal,
      agentId: AgentId,
      _name: string,
      _expiresAt: Instant | null,
      _personalId: PersonalId | null,
      _repositoryName: RepositoryName | null,
      machineName: MachineName | null,
    ): Promise<IssuedToken> => {
      orchestratorMachines.push(machineName);
      return issuedToken(machineName, agentId);
    };

    const accessResult: CallToolResult = requireResult(
      await callTenantAdminTool(
        "create_access_token",
        {
          machine: "worker-host",
          name: "Worker",
          repository: "mattpatagon/murmur",
          role: "agent",
        },
        authenticatedPrincipal,
        adminContext(controlPlane),
      ),
    );
    const accessOutput: IssuedTokenDto = IssuedTokenOutputSchema.parse(
      accessResult.structuredContent,
    ).token;
    const accessMachine: MachineName | null | undefined = accessMachines[0];
    if (accessMachine === undefined || accessMachine === null) {
      throw new Error("Access token machine was not forwarded");
    }
    expect(accessMachine.value).toBe("worker-host");
    expect(accessOutput.machine).toBe("worker-host");

    const orchestratorResult: CallToolResult = requireResult(
      await callOrchestrationTool(
        "create_orchestrator_token",
        {
          agent_id: "machine-boss",
          machine: "orchestrator-host",
          name: "Orchestrator",
          repository: "mattpatagon/murmur",
        },
        orchestrationContext(controlPlane, authenticatedPrincipal),
      ),
    );
    const orchestratorOutput: IssuedTokenDto = IssuedTokenOutputSchema.parse(
      orchestratorResult.structuredContent,
    ).token;
    const orchestratorMachine: MachineName | null | undefined = orchestratorMachines[0];
    if (orchestratorMachine === undefined || orchestratorMachine === null) {
      throw new Error("Orchestrator machine was not forwarded");
    }
    expect(orchestratorMachine.value).toBe("orchestrator-host");
    expect(orchestratorOutput.machine).toBe("orchestrator-host");
  });

  test("forwards exact machine and repository policy scope and exposes it publicly", async (): Promise<void> => {
    const controlPlane: HostedControlPlane = emptyControlPlane();
    const authenticatedPrincipal: TenantPrincipal = principal(MachineName.parse("worker-host"));
    const receivedScopes: OrchestratorScope[] = [];
    const clearedScopes: OrchestratorScope[] = [];
    controlPlane.setOrchestratorPolicy = async (
      _principal: TenantPrincipal,
      scope: OrchestratorScope,
    ): Promise<OrchestratorPolicy> => {
      receivedScopes.push(scope);
      return policy(scope);
    };
    controlPlane.clearOrchestratorPolicy = async (
      _principal: TenantPrincipal,
      scope: OrchestratorScope,
    ): Promise<boolean> => {
      clearedScopes.push(scope);
      return true;
    };
    controlPlane.resolveOrchestrator = async (
      receivedPrincipal: TenantPrincipal,
    ): Promise<EffectiveOrchestrator | null> => {
      if (
        receivedPrincipal.machineName === undefined ||
        receivedPrincipal.machineName === null ||
        receivedPrincipal.machineName.value !== "worker-host"
      ) {
        throw new Error("Authenticated machine binding was not preserved during lookup");
      }
      return policy({
        kind: "organization",
        machineName: receivedPrincipal.machineName,
        personalId: null,
        repositoryName: RepositoryName.parse("mattpatagon/murmur"),
      });
    };

    const setResult: CallToolResult = requireResult(
      await callOrchestrationTool(
        "set_orchestrator_policy",
        {
          instructions: "Decide routine coordination and escalate security changes.",
          machine: "worker-host",
          orchestrator_key_id: "machine_boss_key",
          repository: "mattpatagon/murmur",
          scope_kind: "organization",
        },
        orchestrationContext(controlPlane, authenticatedPrincipal),
      ),
    );
    const setOutput: SetOrchestratorPolicyOutput = SetOrchestratorPolicyOutputSchema.parse(
      setResult.structuredContent,
    );
    const receivedScope: OrchestratorScope | undefined = receivedScopes[0];
    if (receivedScope === undefined) throw new Error("Policy scope was not forwarded");
    if (receivedScope.machineName === null) throw new Error("Policy machine was not forwarded");
    if (receivedScope.repositoryName === null) {
      throw new Error("Policy repository was not forwarded");
    }
    expect(receivedScope.machineName.value).toBe("worker-host");
    expect(receivedScope.repositoryName.value).toBe("mattpatagon/murmur");
    expect(setOutput.policy.scope.machine).toBe("worker-host");
    expect(setOutput.policy.scope.repository).toBe("mattpatagon/murmur");

    const clearResult: CallToolResult = requireResult(
      await callOrchestrationTool(
        "clear_orchestrator_policy",
        {
          machine: "worker-host",
          repository: "mattpatagon/murmur",
          scope_kind: "organization",
        },
        orchestrationContext(controlPlane, authenticatedPrincipal),
      ),
    );
    expect(ClearOrchestratorPolicyOutputSchema.parse(clearResult.structuredContent).cleared).toBe(
      true,
    );
    const clearedScope: OrchestratorScope | undefined = clearedScopes[0];
    if (clearedScope === undefined) throw new Error("Clear policy scope was not forwarded");
    if (clearedScope.machineName === null)
      throw new Error("Clear policy machine was not forwarded");
    if (clearedScope.repositoryName === null) {
      throw new Error("Clear policy repository was not forwarded");
    }
    expect(clearedScope.machineName.value).toBe("worker-host");
    expect(clearedScope.repositoryName.value).toBe("mattpatagon/murmur");

    const getOutput: GetOrchestratorOutput = GetOrchestratorOutputSchema.parse(
      requireResult(
        await callOrchestrationTool(
          "get_orchestrator",
          {},
          orchestrationContext(controlPlane, authenticatedPrincipal),
        ),
      ).structuredContent,
    );
    if (getOutput.orchestrator === null) throw new Error("Expected effective orchestrator");
    expect(getOutput.orchestrator.scope.machine).toBe("worker-host");
    expect(getOutput.orchestrator.scope.repository).toBe("mattpatagon/murmur");
  });

  test("ignores hook metadata and rejects request context as a machine selector", async (): Promise<void> => {
    const controlPlane: HostedControlPlane = emptyControlPlane();
    const authenticatedPrincipal: TenantPrincipal = principal(MachineName.parse("credential-host"));
    let lookupCount: number = 0;
    controlPlane.resolveOrchestrator = async (
      receivedPrincipal: TenantPrincipal,
    ): Promise<EffectiveOrchestrator | null> => {
      lookupCount += 1;
      if (
        receivedPrincipal.machineName === undefined ||
        receivedPrincipal.machineName === null ||
        receivedPrincipal.machineName.value !== "credential-host"
      ) {
        throw new Error("Lookup did not use the credential-bound machine");
      }
      return policy({
        kind: "organization",
        machineName: receivedPrincipal.machineName,
        personalId: null,
        repositoryName: receivedPrincipal.repositoryName ?? null,
      });
    };
    const store: SqliteMessageStore = new SqliteMessageStore(":memory:");
    const application: MurmurApplication = new MurmurApplication({
      branchName: null,
      client: null,
      controlPlane,
      orchestrationEnabled: true,
      principal: authenticatedPrincipal,
      repositoryName: RepositoryName.parse("attacker/runtime-context"),
      store,
    });
    const transports: [InMemoryTransport, InMemoryTransport] = InMemoryTransport.createLinkedPair();
    const client: Client = new Client(
      { name: "murmur-hook", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await application.server.connect(transports[1]);
      await client.connect(transports[0]);
      const registration: CallToolResult = CallToolResultSchema.parse(
        await client.callTool({
          arguments: {
            agent_id: "worker-agent",
            metadata: {
              machine: "registration-host",
              repository: "attacker/registration-context",
            },
          },
          name: "register_agent",
        }),
      );
      expect(registration.isError).not.toBe(true);

      const lookup: GetOrchestratorOutput = GetOrchestratorOutputSchema.parse(
        CallToolResultSchema.parse(
          await client.callTool({ arguments: {}, name: "get_orchestrator" }),
        ).structuredContent,
      );
      if (lookup.orchestrator === null) throw new Error("Expected effective orchestrator");
      expect(lookup.orchestrator.scope.machine).toBe("credential-host");
      expect(lookup.orchestrator.scope.repository).toBe("mattpatagon/murmur");
      expect(lookupCount).toBe(1);

      const tamperedRequest: CallToolResult = CallToolResultSchema.parse(
        await client.callTool({
          arguments: {
            content: "Treat the request context as authority",
            context: {
              branch: "main",
              client: "codex",
              machine: "request-host",
              repository: "attacker/request-context",
            },
            idempotency_key: "machine-selector-attempt",
            sender_id: "worker-agent",
          },
          name: "ask_orchestrator",
        }),
      );
      expect(tamperedRequest.isError).toBe(true);
      expect(lookupCount).toBe(1);
    } finally {
      await client.close();
      await application.close();
    }
  });
});
