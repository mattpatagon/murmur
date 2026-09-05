import { expect } from "bun:test";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { approveExactRequest } from "../../src/admin/approval-request.js";

const RpcSchema: z.ZodType<{
  readonly id: string | number;
  readonly method?: string | undefined;
}> = z.object({ id: z.union([z.string(), z.number()]), method: z.string().optional() });

export async function readApprovedHostedResponse(
  response: Response,
  expectedTool: string,
  expectedArguments: Record<string, unknown>,
  reply: (id: string | number, result: ElicitResult) => Promise<Response>,
): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return await response.json();
  }
  if (response.body === null) throw new Error("Hosted MCP response has no body");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder: TextDecoder = new TextDecoder();
  let buffered: string = "";
  let totalBytes: number = 0;
  try {
    while (true) {
      const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (chunk.done) throw new Error("Hosted MCP stream ended before its response");
      totalBytes += chunk.value.byteLength;
      if (totalBytes > 8_388_608) throw new Error("Hosted MCP test response exceeds its bound");
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline: number = buffered.indexOf("\n");
      while (newline >= 0) {
        const line: string = buffered.slice(0, newline).trimEnd();
        buffered = buffered.slice(newline + 1);
        if (line.startsWith("data: ")) {
          const message: unknown = JSON.parse(line.slice(6));
          const envelope: z.ZodSafeParseResult<z.infer<typeof RpcSchema>> =
            RpcSchema.safeParse(message);
          if (envelope.success) {
            if (envelope.data.method === "elicitation/create") {
              const result: ElicitResult = approveExactRequest(
                ElicitRequestSchema.parse(message),
                expectedTool,
                expectedArguments,
              );
              expect(result.action).toBe("accept");
              const accepted: Response = await reply(envelope.data.id, result);
              expect(accepted.status).toBe(202);
              await accepted.arrayBuffer();
            } else if (envelope.data.method === undefined) return message;
          }
        }
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
