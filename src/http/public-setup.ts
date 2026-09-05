import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../../package.json" with { type: "json" };
import { callSetupGuideTool, setupGuideToolDefinition } from "../mcp/murmur-setup-guide.js";
import { toolError } from "../mcp/murmur-tool-results.js";
import type { RequestObservation } from "../observability/request-observation.js";
import {
  type HttpCapacityController,
  SYSTEM_TIME_SOURCE,
  type TimeSource,
} from "./http-capacity.js";
import { jsonResponse, originIsAllowed } from "./http-request.js";
import { readPublicSetupBody } from "./public-setup-body.js";
import { publicSetupResponse } from "./public-setup-response.js";

export { PUBLIC_SETUP_PATH } from "./http-config.js";

type PublicSetupOptions = {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly capacity: HttpCapacityController;
  readonly bodyTimeoutMs?: number | undefined;
  readonly time?: TimeSource | undefined;
};

function setupServer(): Server {
  const tools: Tool[] = [setupGuideToolDefinition()];
  const server: Server = new Server(
    { name: "murmur-setup", version: packageMetadata.version },
    {
      capabilities: { tools: {} },
      instructions:
        "This public Murmur setup connection needs no token or repository access. Call get_setup_guide to guide the user through organization signup, private credential configuration, hooks, encryption, and approved orchestration. It is read-only and cannot access tenant messages or credentials. After setup reconnect the same MCP name to the authenticated /mcp endpoint using the ordinary agent token; keep owner credentials in the user's separate administrative connection.",
    },
  );
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => ({ tools }),
  );
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      try {
        return (
          callSetupGuideTool(request.params.name, request.params.arguments, tools) ??
          toolError(new Error("Unknown setup tool"))
        );
      } catch (_error: unknown) {
        return toolError(new Error("Invalid setup guide request"));
      }
    },
  );
  return server;
}

export function createPublicSetupHandler(
  options: PublicSetupOptions,
): (request: Request, observation: RequestObservation) => Promise<Response> {
  const timeoutMs: number = options.bodyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000)
    throw new Error("Invalid public setup deadline");
  return async (request: Request, observation: RequestObservation): Promise<Response> => {
    if (!originIsAllowed(request, options.allowedOrigins)) {
      observation.recordOrigin("rejected");
      return jsonResponse(403, { error: "Origin is not allowed" });
    }
    observation.recordOrigin("allowed");
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    const mediaType: string = (request.headers.get("content-type") ?? "").split(";", 1)[0] ?? "";
    if (mediaType.trim().toLowerCase() !== "application/json") {
      return jsonResponse(415, { error: "Content-Type must be application/json" });
    }
    if (!options.capacity.rateLimitAllows("public-setup", 600)) {
      return Response.json(
        { error: "Setup rate limit reached" },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    const release: (() => void) | null = options.capacity.reservePublicRequest("public-setup");
    if (release === null) {
      observation.recordRequestCapacity("rejected");
      return Response.json(
        { error: "Setup capacity reached" },
        { status: 503, headers: { "retry-after": "1" } },
      );
    }
    observation.recordRequestCapacity("allowed");
    let server: Server | null = null;
    let handedOff: boolean = false;
    try {
      let body: unknown;
      try {
        body = await readPublicSetupBody(request, timeoutMs, options.time ?? SYSTEM_TIME_SOURCE);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Expected one setup request");
        }
      } catch (_error: unknown) {
        return jsonResponse(400, {
          error: "Setup body must be valid JSON within 8192 bytes and its deadline",
        });
      }
      server = setupServer();
      const transport: WebStandardStreamableHTTPServerTransport =
        new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response: Response = await transport.handleRequest(request, { parsedBody: body });
      const tracked: Response = publicSetupResponse(
        response,
        release,
        options.time ?? SYSTEM_TIME_SOURCE,
      );
      handedOff = true;
      return tracked;
    } finally {
      try {
        if (server !== null) await server.close();
      } finally {
        if (!handedOff) release();
      }
    }
  };
}
