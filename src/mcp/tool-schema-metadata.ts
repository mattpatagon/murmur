import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type OutputSchema = NonNullable<Tool["outputSchema"]>;
const INPUT_SNAPSHOTS: WeakMap<z.ZodType, Tool["inputSchema"]> = new WeakMap<
  z.ZodType,
  Tool["inputSchema"]
>();
const OUTPUT_SNAPSHOTS: WeakMap<z.ZodType, OutputSchema> = new WeakMap<z.ZodType, OutputSchema>();
const OutputSchemaValidator: z.ZodType<OutputSchema> = ToolSchema.shape.outputSchema.unwrap();

function copySnapshot<Metadata extends object>(
  schema: z.ZodType,
  validator: z.ZodType<Metadata>,
  snapshots: WeakMap<z.ZodType, Metadata>,
): Metadata {
  let snapshot: Metadata | undefined = snapshots.get(schema);
  if (snapshot === undefined) {
    const generated: unknown = z.toJSONSchema(schema);
    snapshot = validator.parse(generated);
    snapshots.set(schema, snapshot);
  }
  // Only trusted schema identities are keys. Never expose the retained snapshot to a session.
  return structuredClone(snapshot);
}

export function toolSchemaMetadata(
  input: z.ZodType,
  output: z.ZodType,
): { readonly inputSchema: Tool["inputSchema"]; readonly outputSchema: OutputSchema } {
  return {
    inputSchema: copySnapshot(input, ToolSchema.shape.inputSchema, INPUT_SNAPSHOTS),
    outputSchema: copySnapshot(output, OutputSchemaValidator, OUTPUT_SNAPSHOTS),
  };
}
