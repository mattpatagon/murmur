import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../../package.json" with { type: "json" };

import { RETENTION_DAYS } from "../domain/contracts.js";
import type { AgentClient, BranchName, RepositoryName, TenantId } from "../domain/value-objects.js";
import type { HostedControlPlane, HostedPrincipal } from "../hosted/control-plane.js";
import { logSafeError } from "../safe-errors.js";
import type { MessageStore } from "../storage/message-store.js";
import {
  type AdminToolContext,
  callBootstrapTool,
  callOperatorTool,
  callTenantAdminTool,
} from "./murmur-admin-tools.js";
import { callDataTool, type DataToolContext } from "./murmur-data-tools.js";
import { MurmurInboxResources } from "./murmur-inbox-resources.js";
import { toolsForPrincipal } from "./murmur-tool-definitions.js";
import { toolError } from "./murmur-tool-results.js";

const SERVER_VERSION: string = packageMetadata.version;

export type MurmurApplicationDependencies = {
  readonly branchName: BranchName | null;
  readonly bootstrapCredentialHash?: Buffer | null;
  readonly client: AgentClient | null;
  readonly closeStoreOnClose?: boolean;
  readonly controlPlane?: HostedControlPlane | null;
  readonly legacyCredentialHash?: Buffer | null;
  readonly onTenantSuspended?: ((tenantId: TenantId) => Promise<void>) | undefined;
  readonly onTokenRevoked?: ((tokenId: string) => Promise<void>) | undefined;
  readonly onRepositoryDivergence?: (() => void) | undefined;
  readonly principal?: HostedPrincipal | null;
  readonly repositoryName: RepositoryName | null;
  readonly store: MessageStore | null;
  readonly tenantOnboardingEnabled?: boolean;
};

export class MurmurApplication {
  public readonly server: Server;
  private readonly bootstrapCredentialHash: Buffer | null;
  private readonly branchName: BranchName | null;
  private readonly client: AgentClient | null;
  private readonly controlPlane: HostedControlPlane | null;
  private readonly legacyCredentialHash: Buffer | null;
  private readonly onTenantSuspended: ((tenantId: TenantId) => Promise<void>) | null;
  private readonly onTokenRevoked: ((tokenId: string) => Promise<void>) | null;
  private readonly onRepositoryDivergence: () => void;
  private readonly principal: HostedPrincipal | null;
  private readonly repositoryName: RepositoryName | null;
  private readonly resources: MurmurInboxResources;
  private readonly store: MessageStore | null;
  private readonly tools: Tool[];
  private readonly tenantOnboardingEnabled: boolean;

  public constructor(dependencies: MurmurApplicationDependencies) {
    this.branchName = dependencies.branchName;
    this.bootstrapCredentialHash =
      dependencies.bootstrapCredentialHash === undefined ||
      dependencies.bootstrapCredentialHash === null
        ? null
        : Buffer.from(dependencies.bootstrapCredentialHash);
    this.client = dependencies.client;
    this.controlPlane = dependencies.controlPlane ?? null;
    this.legacyCredentialHash = dependencies.legacyCredentialHash ?? null;
    this.onTenantSuspended = dependencies.onTenantSuspended ?? null;
    this.onTokenRevoked = dependencies.onTokenRevoked ?? null;
    this.onRepositoryDivergence = dependencies.onRepositoryDivergence ?? ((): void => undefined);
    this.principal = dependencies.principal ?? null;
    this.repositoryName = dependencies.repositoryName;
    this.store = dependencies.store;
    this.tenantOnboardingEnabled = dependencies.tenantOnboardingEnabled === true;
    this.tools = this.createTools();
    this.server = new Server(
      { name: "murmur", version: SERVER_VERSION },
      {
        capabilities: {
          resources: { listChanged: true, subscribe: true },
          tools: {},
        },
        instructions:
          "Murmur provides durable agent-to-agent inboxes. Call register_agent first, then send_message, broadcast_message, or get_messages. " +
          "Outgoing messages include context.repository, context.branch, context.client, and a created_at timestamp. " +
          "Repository, branch, and client are detected from the launching agent when possible; otherwise send_message or broadcast_message must supply them in context. " +
          "For push signals, subscribe to murmur://inbox/{agent_id}; always read the durable inbox after a notification or reconnect. " +
          `Messages expire automatically after ${RETENTION_DAYS} days. MCP notifications do not themselves guarantee that a host starts a new model turn.`,
      },
    );
    this.resources = new MurmurInboxResources(
      this.server,
      this.store,
      dependencies.closeStoreOnClose !== false,
    );
    this.registerRequestHandlers();
    this.resources.registerHandlers();
    this.server.onclose = (): void => {
      void this.resources.close().catch((error: unknown): void => {
        logSafeError("Murmur resource shutdown failed", error);
      });
    };
  }

  private createTools(): Tool[] {
    return toolsForPrincipal({
      bootstrapEnabled: this.bootstrapCredentialHash !== null,
      legacyAdoptionEnabled: this.legacyCredentialHash !== null,
      principal: this.principal,
      tenantOnboardingEnabled: this.tenantOnboardingEnabled,
    });
  }

  private registerRequestHandlers(): void {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (): Promise<ListToolsResult> => ({ tools: this.tools }),
    );
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest): Promise<CallToolResult> => await this.callTool(request),
    );
  }

  private async callTool(request: CallToolRequest): Promise<CallToolResult> {
    try {
      const name: string = request.params.name;
      const argumentsValue: unknown = request.params.arguments;
      const dataContext: DataToolContext = {
        branchName: this.branchName,
        client: this.client,
        notifyResourceListChanged: async (): Promise<void> =>
          await this.server.sendResourceListChanged(),
        recordRepositoryDivergence: this.onRepositoryDivergence,
        repositoryName: this.repositoryName,
        store: this.store,
      };
      const dataResult: CallToolResult | null = await callDataTool(
        name,
        argumentsValue,
        dataContext,
      );
      if (dataResult !== null) return dataResult;
      if (this.controlPlane !== null && this.principal !== null) {
        const adminContext: AdminToolContext = {
          controlPlane: this.controlPlane,
          legacyCredentialHash: this.legacyCredentialHash,
          onTenantSuspended: this.onTenantSuspended,
          onTokenRevoked: this.onTokenRevoked,
          tenantOnboardingEnabled: this.tenantOnboardingEnabled,
        };
        if (this.principal.kind === "tenant" && this.principal.role === "tenant_admin") {
          const result: CallToolResult | null = await callTenantAdminTool(
            name,
            argumentsValue,
            this.principal,
            adminContext,
          );
          if (result !== null) return result;
        }
        if (this.principal.kind === "operator") {
          const result: CallToolResult | null = await callOperatorTool(
            name,
            argumentsValue,
            this.principal,
            adminContext,
          );
          if (result !== null) return result;
        }
        if (this.principal.kind === "bootstrap" && this.bootstrapCredentialHash !== null) {
          const result: CallToolResult | null = await callBootstrapTool(
            name,
            argumentsValue,
            this.bootstrapCredentialHash,
            adminContext,
          );
          if (result !== null) return result;
        }
      }
      return toolError(new Error(`Unknown tool '${name}'`));
    } catch (error: unknown) {
      return toolError(error);
    }
  }

  public async close(): Promise<void> {
    await this.resources.close();
    await this.server.close();
  }
}
