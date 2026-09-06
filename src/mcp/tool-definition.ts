import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import { toolSchemaMetadata } from "./tool-schema-metadata.js";

export function toolDefinition<Input, Output>(
  name: string,
  title: string,
  description: string,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  annotations: ToolAnnotations,
): Tool {
  const metadata: ReturnType<typeof toolSchemaMetadata> = toolSchemaMetadata(
    inputSchema,
    outputSchema,
  );
  return {
    annotations: structuredClone(annotations),
    description,
    inputSchema: metadata.inputSchema,
    name,
    outputSchema: metadata.outputSchema,
    title,
  };
}
