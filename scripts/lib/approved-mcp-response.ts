import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { approveExactRequest } from "../../src/admin/approval-request.js";

const RpcSchema: z.ZodType<{
  readonly id: string | number;
  readonly method?: string | undefined;
}> = z.object({ id: z.union([z.string(), z.number()]), method: z.string().optional() });

async function boundedJsonResponse(
  response: Response,
  expectedId: string | number,
): Promise<unknown> {
  if (response.body === null) throw new Error("Murmur returned an empty MCP response");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  try {
    while (true) {
      const next: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 8_388_608) throw new Error("Murmur response exceeds its bound");
      chunks.push(next.value);
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const envelope: z.infer<typeof RpcSchema> = RpcSchema.parse(parsed);
    if (envelope.id !== expectedId || envelope.method !== undefined) {
      throw new Error("Murmur returned an unexpected MCP response");
    }
    return parsed;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

// This adapter is only for operations explicitly declared by the reviewed bootstrap/canary plan.
// Remote text never chooses an operation or its arguments, and every other request is declined.
export async function readApprovedMcpResponse(
  response: Response,
  expectedId: string | number,
  expectedTool: string,
  expectedArguments: Record<string, unknown>,
  reply: (id: string | number, result: ElicitResult) => Promise<Response>,
): Promise<unknown> {
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel();
    throw new Error(`Murmur returned HTTP ${response.status}`);
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return await boundedJsonResponse(response, expectedId);
  }
  if (response.body === null) throw new Error("Murmur returned an empty MCP stream");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder: TextDecoder = new TextDecoder("utf8", { fatal: true });
  let buffered: string = "";
  let total: number = 0;
  let approved: boolean = false;
  try {
    while (true) {
      const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (chunk.done) throw new Error("Murmur stream ended before the expected result");
      total += chunk.value.byteLength;
      if (total > 8_388_608) throw new Error("Murmur response exceeds its bound");
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline: number = buffered.indexOf("\n");
      while (newline >= 0) {
        const line: string = buffered.slice(0, newline).trimEnd();
        buffered = buffered.slice(newline + 1);
        if (line.startsWith("data: ")) {
          const message: unknown = JSON.parse(line.slice(6));
          const envelope: z.ZodSafeParseResult<z.infer<typeof RpcSchema>> =
            RpcSchema.safeParse(message);
          if (envelope.success && envelope.data.method === "elicitation/create") {
            const result: ElicitResult = approved
              ? { action: "decline" }
              : approveExactRequest(
                  ElicitRequestSchema.parse(message),
                  expectedTool,
                  expectedArguments,
                );
            approved = true;
            const receipt: Response = await reply(envelope.data.id, result);
            if (receipt.body !== null) await receipt.body.cancel();
            if (receipt.status !== 202 || result.action !== "accept") {
              throw new Error("Murmur requested a change outside the approved verification plan");
            }
          } else if (
            envelope.success &&
            envelope.data.method === undefined &&
            envelope.data.id === expectedId
          ) {
            return message;
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
