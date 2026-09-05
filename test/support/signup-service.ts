import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { CreateTenantOutput, IssuedTokenOutput } from "../../src/hosted/contracts.js";

export type SignupTestService = {
  readonly endpoint: string;
  readonly issued: () => number;
  readonly registrations: () => number;
  readonly stop: () => Promise<void>;
};

export function signupTestService(
  owner: CreateTenantOutput,
  worker: IssuedTokenOutput,
): SignupTestService {
  let issued: number = 0;
  let registrations: number = 0;
  let pending: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pendingId: string | number | null = null;
  const encoder: TextEncoder = new TextEncoder();
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname === "/v1/tenants") {
        registrations += 1;
        return Response.json(owner, { status: 201 });
      }
      if (request.headers.get("authorization") !== `Bearer ${owner.token.secret}`) {
        return new Response(null, { status: 401 });
      }
      if (request.method !== "POST") return new Response(null, { status: 202 });
      const message: JSONRPCMessage = JSONRPCMessageSchema.parse(await request.json());
      if (!("method" in message)) {
        const controller: ReadableStreamDefaultController<Uint8Array> | null = pending;
        if (controller === null || pendingId === null)
          throw new Error("Missing signup approval stream");
        const accepted: boolean =
          "result" in message &&
          typeof message.result === "object" &&
          message.result !== null &&
          message.result["action"] === "accept";
        if (accepted) issued += 1;
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: pendingId,
              result: accepted
                ? { content: [], structuredContent: worker }
                : { content: [], isError: true },
            })}\n\n`,
          ),
        );
        controller.close();
        pending = null;
        pendingId = null;
        return new Response(null, { status: 202 });
      }
      if (!("id" in message)) return new Response(null, { status: 202 });
      if (message.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "signup-fixture", version: "1.0.0" },
          },
        });
      }
      if (message.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      }
      pendingId = message.id;
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
            pending = controller;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  jsonrpc: "2.0",
                  id: "signup-approval",
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Approve create_access_token for role agent",
                    requestedSchema: {
                      type: "object",
                      properties: {
                        confirmation: {
                          type: "string",
                          enum: ["approve:41000000-0000-4000-8000-000000000001"],
                        },
                      },
                      required: ["confirmation"],
                    },
                  },
                })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}/mcp`,
    issued: (): number => issued,
    registrations: (): number => registrations,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}
