import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { BoundedJsonObjectSchema, type JsonObject } from "../src/domain/value-objects.js";
import { toolResult } from "../src/mcp/murmur-tool-results.js";

function resultText(result: CallToolResult): string {
  const content: CallToolResult["content"][number] | undefined = result.content[0];
  if (content === undefined || content.type !== "text") {
    throw new Error("Expected JSON tool text");
  }
  return content.text;
}

test("valid dense metadata does not amplify tool text through indentation", (): void => {
  const metadata: JsonObject = BoundedJsonObjectSchema.parse({
    items: Array.from({ length: 70 }, (): number[] => Array.from({ length: 100 }, (): number => 0)),
  });
  const output: Record<string, unknown> = { agents: [{ metadata }] };
  const compactBytes: number = Buffer.byteLength(JSON.stringify(output), "utf8");
  const result: CallToolResult = toolResult(output);

  expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThan(16 * 1024);
  expect(Buffer.byteLength(resultText(result), "utf8")).toBeLessThanOrEqual(compactBytes);
  expect(result.structuredContent).toBe(output);
  expect(JSON.parse(resultText(result))).toEqual(output);
});

test("compact tool text preserves Unicode, control characters and nested values", (): void => {
  const output: Record<string, unknown> = {
    content: "message\n\t\u0001",
    unicode: ["café", "漢字", "🌊"],
    quoted: '"quotes" and \\ slashes',
    metadata: { empty: {}, nested: [null, true, false, 42, { value: "unchanged" }] },
  };
  const result: CallToolResult = toolResult(output);
  const text: string = resultText(result);

  expect(text.includes("\n")).toBe(false);
  expect(JSON.parse(text)).toEqual(output);
  expect(result.structuredContent).toEqual(output);
  expect(result.isError).toBeUndefined();
});
