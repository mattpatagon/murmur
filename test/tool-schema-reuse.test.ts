import { expect, spyOn, test } from "bun:test";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { encryptedWireToolDefinitions } from "../src/e2ee/wire-tool-definitions.js";
import { toolsForPrincipal } from "../src/mcp/murmur-tool-definitions.js";
import { toolDefinition } from "../src/mcp/tool-definition.js";

function definition(input: z.ZodType, output: z.ZodType, annotations: ToolAnnotations): Tool {
  return toolDefinition("fixture", "Fixture", "Schema reuse fixture", input, output, annotations);
}

function changeProperty(schema: Tool["inputSchema"], name: string): void {
  const properties: Record<string, object> | undefined = schema.properties;
  if (properties === undefined) throw new Error("Expected schema properties");
  const property: object | undefined = properties[name];
  if (property === undefined) throw new Error("Expected a schema property");
  Object.assign(property, { description: "Caller mutation" });
  schema.required = ["caller_mutation"];
}

test("tool schemas convert once per stable identity and return isolated validated metadata", (): void => {
  const input: z.ZodType = z.strictObject({
    payload: z.strictObject({ message: z.string().min(1).max(40) }),
  });
  const output: z.ZodType = z.strictObject({ result: z.array(z.number().int()).max(3) });
  const annotations: ToolAnnotations = { readOnlyHint: true, title: "Fixture" };
  const expectedInput: Tool["inputSchema"] = ToolSchema.shape.inputSchema.parse(
    z.toJSONSchema(input),
  );
  const expectedOutput: NonNullable<Tool["outputSchema"]> = ToolSchema.shape.outputSchema
    .unwrap()
    .parse(z.toJSONSchema(output));
  const convert: ReturnType<typeof spyOn<typeof z, "toJSONSchema">> = spyOn(z, "toJSONSchema");
  try {
    const first: Tool = definition(input, output, annotations);
    const second: Tool = definition(input, output, annotations);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(first.inputSchema).toEqual(expectedInput);
    expect(first.outputSchema).toEqual(expectedOutput);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.inputSchema).not.toBe(first.inputSchema);
    expect(second.outputSchema).not.toBe(first.outputSchema);
    changeProperty(first.inputSchema, "payload");
    if (first.outputSchema === undefined || first.annotations === undefined) {
      throw new Error("Expected output schema and annotations");
    }
    changeProperty(first.outputSchema, "result");
    first.annotations.readOnlyHint = false;
    first.title = "Caller mutation";
    expect(second.inputSchema).toEqual(expectedInput);
    expect(second.outputSchema).toEqual(expectedOutput);
    expect(second.annotations).toEqual({ readOnlyHint: true, title: "Fixture" });
    expect(annotations).toEqual({ readOnlyHint: true, title: "Fixture" });
    const third: Tool = definition(input, output, annotations);
    expect(third).toEqual(second);
    expect(convert).toHaveBeenCalledTimes(2);
  } finally {
    convert.mockRestore();
  }
});

test("tool schema reuse is keyed by schema identity rather than tool name or serialized shape", (): void => {
  const input: z.ZodType = z.strictObject({ value: z.string().max(10) });
  const otherInput: z.ZodType = z.strictObject({ value: z.string().max(20) });
  const output: z.ZodType = z.strictObject({ accepted: z.boolean() });
  const convert: ReturnType<typeof spyOn<typeof z, "toJSONSchema">> = spyOn(z, "toJSONSchema");
  try {
    const first: Tool = definition(input, output, {});
    const second: Tool = definition(otherInput, output, {});
    expect(first.inputSchema).not.toEqual(second.inputSchema);
    expect(convert).toHaveBeenCalledTimes(3);
    expect(definition(input, output, {})).toEqual(first);
    expect(definition(otherInput, output, {})).toEqual(second);
    expect(convert).toHaveBeenCalledTimes(3);
  } finally {
    convert.mockRestore();
  }
});

test("schema reuse never turns invalid non-object MCP schemas into accepted metadata", (): void => {
  const object: z.ZodType = z.strictObject({ value: z.string() });
  const invalid: z.ZodType = z.string();
  for (let attempt: number = 0; attempt < 2; attempt += 1) {
    expect((): Tool => definition(invalid, object, {})).toThrow();
    expect((): Tool => definition(object, invalid, {})).toThrow();
  }
});

function actualDefinitions(): Tool[] {
  return [
    ...toolsForPrincipal({
      bootstrapEnabled: false,
      legacyAdoptionEnabled: false,
      principal: null,
      tenantOnboardingEnabled: false,
    }),
    ...encryptedWireToolDefinitions(),
  ];
}

test("actual plaintext and encrypted catalogs reuse conversion without sharing mutable metadata", (): void => {
  const convert: ReturnType<typeof spyOn<typeof z, "toJSONSchema">> = spyOn(z, "toJSONSchema");
  try {
    const first: Tool[] = actualDefinitions();
    const expected: Tool[] = structuredClone(first);
    const conversions: number = convert.mock.calls.length;
    expect(first.length).toBeGreaterThan(20);
    for (const tool of first) {
      const properties: Record<string, object> | undefined = tool.inputSchema.properties;
      if (properties !== undefined) {
        const name: string | undefined = Object.keys(properties)[0];
        if (name !== undefined) changeProperty(tool.inputSchema, name);
      }
      if (tool.outputSchema !== undefined) tool.outputSchema.required = ["caller_mutation"];
      if (tool.annotations !== undefined)
        tool.annotations.readOnlyHint = !tool.annotations.readOnlyHint;
      tool.title = "Caller mutation";
    }
    const second: Tool[] = actualDefinitions();
    expect(second).toEqual(expected);
    expect(convert.mock.calls.length).toBe(conversions);
    for (const tool of second) expect(ToolSchema.safeParse(tool).success).toBe(true);
  } finally {
    convert.mockRestore();
  }
});
