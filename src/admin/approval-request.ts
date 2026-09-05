import { createHash } from "node:crypto";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const HUMAN_APPROVAL_META_KEY: string = "dev.usemurmur/human-approval";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown): unknown => canonicalValue(item));
  if (typeof value !== "object" || value === null) return value;
  const entries: [string, unknown][] = Object.entries(value).sort(
    (left: [string, unknown], right: [string, unknown]): number =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  return Object.fromEntries(
    entries.map(([key, item]: [string, unknown]): [string, unknown] => [key, canonicalValue(item)]),
  );
}

export function approvalRequestDigest(name: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ arguments: canonicalValue(input), name }))
    .digest("hex");
}

const ApprovalMetadataSchema: z.ZodType<{
  readonly operation: string;
  readonly request_digest: string;
}> = z.strictObject({ operation: z.string(), request_digest: z.string().regex(/^[a-f0-9]{64}$/u) });

export function approveExactRequest(
  request: ElicitRequest,
  expectedTool: string,
  expectedArguments: unknown,
): ElicitResult {
  if (request.params.mode === "url" || request.params._meta === undefined)
    return { action: "decline" };
  const metadata: z.ZodSafeParseResult<z.infer<typeof ApprovalMetadataSchema>> =
    ApprovalMetadataSchema.safeParse(request.params._meta[HUMAN_APPROVAL_META_KEY]);
  if (
    !metadata.success ||
    metadata.data.operation !== expectedTool ||
    metadata.data.request_digest !== approvalRequestDigest(expectedTool, expectedArguments)
  ) {
    return { action: "decline" };
  }
  const confirmation: unknown = request.params.requestedSchema.properties["confirmation"];
  const parsed: z.ZodSafeParseResult<{
    readonly enum: readonly string[];
    readonly type: "string";
  }> = z
    .object({
      enum: z.array(z.string().regex(/^approve:[0-9a-f-]{36}$/u)).length(1),
      type: z.literal("string"),
    })
    .safeParse(confirmation);
  if (!parsed.success) return { action: "decline" };
  const value: string | undefined = parsed.data.enum[0];
  return value === undefined
    ? { action: "decline" }
    : { action: "accept", content: { confirmation: value } };
}
