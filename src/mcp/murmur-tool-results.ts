import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { safeErrorMessage } from "../safe-errors.js";

export function toolResult(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}

export function toolError(error: unknown): CallToolResult {
  const message: string = safeErrorMessage(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}
