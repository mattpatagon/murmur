import { expect, test } from "bun:test";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { readApprovedMcpResponse } from "../scripts/lib/approved-mcp-response.js";
import { approvalRequestDigest, HUMAN_APPROVAL_META_KEY } from "../src/admin/approval-request.js";

const INPUT: Record<string, unknown> = { name: "Test worker", role: "agent" };
const TOOL: string = "create_access_token";
const CHALLENGE: string = "approve:00000000-0000-4000-8000-000000000001";

function prompt(input: unknown): Record<string, unknown> {
  return {
    id: "approval",
    jsonrpc: "2.0",
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Approve this test fixture",
      _meta: {
        [HUMAN_APPROVAL_META_KEY]: {
          operation: TOOL,
          request_digest: approvalRequestDigest(TOOL, input),
        },
      },
      requestedSchema: {
        type: "object",
        properties: {
          confirmation: { type: "string", enum: [CHALLENGE] },
        },
        required: ["confirmation"],
      },
    },
  };
}

function event(value: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}

test("verification approves only the exact locally declared operation before accepting its matching result", async (): Promise<void> => {
  const channel: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
    controller: null,
  };
  const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      channel.controller = controller;
      controller.enqueue(event(prompt(INPUT)));
    },
  });
  let replies: number = 0;
  const output: unknown = await readApprovedMcpResponse(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    "call",
    TOOL,
    INPUT,
    async (id: string | number, result: ElicitResult): Promise<Response> => {
      expect(id).toBe("approval");
      expect(result).toEqual({ action: "accept", content: { confirmation: CHALLENGE } });
      replies += 1;
      if (channel.controller === null) throw new Error("Missing test stream");
      channel.controller.enqueue(event({ id: "call", jsonrpc: "2.0", result: { stored: true } }));
      return new Response(null, { status: 202 });
    },
  );
  expect(replies).toBe(1);
  expect(output).toMatchObject({ id: "call", result: { stored: true } });
});

test("verification declines altered or replayed grant requests", async (): Promise<void> => {
  for (const events of [
    [prompt({ ...INPUT, role: "tenant_admin" })],
    [prompt(INPUT), prompt(INPUT)],
  ]) {
    const response: Response = new Response(Buffer.concat(events.map(event)), {
      headers: { "content-type": "text/event-stream" },
    });
    const replies: ElicitResult[] = [];
    await expect(
      readApprovedMcpResponse(
        response,
        "call",
        TOOL,
        INPUT,
        async (_id: string | number, result: ElicitResult): Promise<Response> => {
          replies.push(result);
          return new Response(null, { status: 202 });
        },
      ),
    ).rejects.toThrow("outside the approved verification plan");
    expect(replies.at(-1)).toEqual({ action: "decline" });
  }
});

test("JSON verification responses must match the expected request and stay bounded", async (): Promise<void> => {
  const reply: (_id: string | number, _result: ElicitResult) => Promise<Response> =
    async (): Promise<Response> => {
      throw new Error("Unexpected approval");
    };
  const valid: unknown = await readApprovedMcpResponse(
    Response.json({ id: 4, result: {} }),
    4,
    TOOL,
    INPUT,
    reply,
  );
  expect(valid).toEqual({ id: 4, result: {} });
  await expect(
    readApprovedMcpResponse(Response.json({ id: 5, result: {} }), 4, TOOL, INPUT, reply),
  ).rejects.toThrow("unexpected MCP response");
  await expect(
    readApprovedMcpResponse(new Response(new Uint8Array(8_388_609)), 4, TOOL, INPUT, reply),
  ).rejects.toThrow("exceeds its bound");
  await expect(
    readApprovedMcpResponse(new Response(null, { status: 503 }), 4, TOOL, INPUT, reply),
  ).rejects.toThrow("HTTP 503");
});
