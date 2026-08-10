import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export function toolDefinition<Input, Output>(
  name: string,
  title: string,
  description: string,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  annotations: ToolAnnotations,
): Tool {
  const generatedInput: unknown = z.toJSONSchema(inputSchema);
  const generatedOutput: unknown = z.toJSONSchema(outputSchema);
  const validatedInput: Tool["inputSchema"] = ToolSchema.shape.inputSchema.parse(generatedInput);
  const validatedOutput: NonNullable<Tool["outputSchema"]> = ToolSchema.shape.outputSchema
    .unwrap()
    .parse(generatedOutput);
  return {
    annotations,
    description,
    inputSchema: validatedInput,
    name,
    outputSchema: validatedOutput,
    title,
  };
}
