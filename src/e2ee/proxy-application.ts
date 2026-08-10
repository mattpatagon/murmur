import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../../package.json" with { type: "json" };

import { logSafeError } from "../safe-errors.js";
import { toolError } from "../mcp/murmur-tool-results.js";
import type { E2eeProxyOperations } from "./proxy-service.js";
import { callE2eeProxyTool, e2eeProxyTools } from "./proxy-tools.js";

export class E2eeProxyApplication {
  readonly #operations: E2eeProxyOperations;
  readonly #tools: readonly Tool[];
  public readonly server: Server;

  public constructor(operations: E2eeProxyOperations) {
    this.#operations = operations;
    this.#tools = e2eeProxyTools();
    this.server = new Server(
      { name: "murmur-e2ee-proxy", version: packageMetadata.version },
      {
        capabilities: { tools: {} },
        instructions:
          "Murmur end-to-end encryption runs at this local endpoint. Use the familiar register_agent, list_agents, send_message, broadcast_message, get_messages, wait_for_messages, and mark_messages_read tools. Message plaintext and private keys never leave this proxy; hosted Murmur receives ciphertext and bounded routing metadata only. Verify peer root fingerprints before exchanging sensitive content.",
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
    this.server.onclose = (): void => {
      void this.#operations.close().catch((error: unknown): void => {
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
      return result === null
        ? toolError(new Error(`Unknown tool '${request.params.name}'`))
        : result;
    } catch (error: unknown) {
      return toolError(error);
    }
  }

  public async close(): Promise<void> {
    await this.#operations.close();
    await this.server.close();
  }
}
