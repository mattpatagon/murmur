import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../../package.json" with { type: "json" };
import { toolError } from "../mcp/murmur-tool-results.js";
import { logSafeError } from "../safe-errors.js";
import { E2eeProxyResources } from "./proxy-resources.js";
import type { E2eeProxyOperations } from "./proxy-service.js";
import { callE2eeProxyTool, e2eeProxyTools } from "./proxy-tools.js";

export class E2eeProxyApplication {
  readonly #operations: E2eeProxyOperations;
  readonly #resources: E2eeProxyResources;
  readonly #tools: readonly Tool[];
  #closePromise: Promise<void> | null = null;
  #localClosePromise: Promise<void> | null = null;
  #onCloseCleanupStarted: boolean = false;
  public readonly server: Server;

  public constructor(operations: E2eeProxyOperations) {
    this.#operations = operations;
    this.#tools = e2eeProxyTools();
    this.server = new Server(
      { name: "murmur-e2ee-proxy", version: packageMetadata.version },
      {
        capabilities: {
          resources: { listChanged: true, subscribe: true },
          tools: {},
        },
        instructions:
          "Murmur end-to-end encryption runs at this local endpoint. Familiar agent lifecycle and message tools remain available. Message plaintext and private keys never leave this proxy; hosted Murmur receives ciphertext and bounded routing metadata only. Feedback is an explicit exception: submit_feedback stores maintainer-readable plaintext, so never include credentials, secrets, private message content, vulnerability details, or sensitive production data. Report suspected vulnerabilities privately at https://github.com/mattpatagon/murmur/security/advisories/new. Verify peer root fingerprints before exchanging sensitive content.",
      },
    );
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (): Promise<ListToolsResult> => ({ tools: [...this.#tools] }),
    );
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest): Promise<CallToolResult> => await this.callTool(request),
    );
    this.#resources = new E2eeProxyResources(this.server, operations);
    this.#resources.registerHandlers();
    this.server.onclose = (): void => {
      if (this.#onCloseCleanupStarted) return;
      this.#onCloseCleanupStarted = true;
      void this.closeLocalResources().catch((error: unknown): void => {
        logSafeError("Murmur E2E proxy shutdown failed", error);
      });
    };
  }

  private async callTool(request: CallToolRequest): Promise<CallToolResult> {
    try {
      const result: CallToolResult | null = await callE2eeProxyTool(
        request.params.name,
        request.params.arguments,
        this.#operations,
      );
      const changesAgentResources: boolean =
        request.params.name === "register_agent" ||
        request.params.name === "end_session" ||
        request.params.name === "close_agent";
      if (result !== null && result.isError !== true && changesAgentResources) {
        await this.server.sendResourceListChanged();
      }
      return result === null
        ? toolError(new Error(`Unknown tool '${request.params.name}'`))
        : result;
    } catch (error: unknown) {
      return toolError(error);
    }
  }

  private async closeLocalResourcesOnce(): Promise<void> {
    let resourcesFailed: boolean = false;
    try {
      await this.#resources.close();
    } catch (_error: unknown) {
      resourcesFailed = true;
    }
    let operationsFailed: boolean = false;
    try {
      await this.#operations.close();
    } catch (_error: unknown) {
      operationsFailed = true;
    }
    if (resourcesFailed || operationsFailed) {
      throw new Error("The local E2E proxy cleanup failed");
    }
  }

  private async closeLocalResources(): Promise<void> {
    if (this.#localClosePromise === null) {
      this.#localClosePromise = this.closeLocalResourcesOnce();
    }
    await this.#localClosePromise;
  }

  private async closeOnce(): Promise<void> {
    let localFailed: boolean = false;
    try {
      await this.closeLocalResources();
    } catch (_error: unknown) {
      localFailed = true;
    }
    let serverFailed: boolean = false;
    try {
      await this.server.close();
    } catch (_error: unknown) {
      serverFailed = true;
    }
    if (localFailed || serverFailed) throw new Error("The local E2E proxy shutdown failed");
  }

  public async close(): Promise<void> {
    if (this.#closePromise === null) this.#closePromise = this.closeOnce();
    await this.#closePromise;
  }
}
