import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  ORGANIZATIONS_GUIDE,
  ORCHESTRATION_GUIDE,
  TROUBLESHOOTING_GUIDE,
} from "../setup/guide-administration.js";
import { ENCRYPTION_GUIDE, FEATURES_GUIDE } from "../setup/guide-features.js";
import { HOOK_GUIDE, INSTALLATION_GUIDE } from "../setup/guide-installation.js";
import { toolResult } from "./murmur-tool-results.js";
import { toolDefinition } from "./tool-definition.js";

type GuideTopic =
  | "installation"
  | "hooks"
  | "features"
  | "encryption"
  | "orchestration"
  | "organizations"
  | "troubleshooting";

type SetupGuideInput = {
  readonly topic: GuideTopic | "all";
};

type GuideSection = {
  readonly topic: GuideTopic;
  readonly instructions: string;
};

export type SetupGuideOutput = {
  readonly version: string;
  readonly available_tools: readonly string[];
  readonly sections: readonly GuideSection[];
};

const GuideTopicSchema: z.ZodType<GuideTopic> = z.enum([
  "installation",
  "hooks",
  "features",
  "encryption",
  "orchestration",
  "organizations",
  "troubleshooting",
]);
const SetupGuideInputSchema: z.ZodType<SetupGuideInput> = z.strictObject({
  topic: z.union([GuideTopicSchema, z.literal("all")]).default("all"),
});
export const SetupGuideOutputSchema: z.ZodType<SetupGuideOutput> = z.strictObject({
  version: z.string().max(43),
  available_tools: z.array(z.string().min(1).max(100)).max(100),
  sections: z
    .array(
      z.strictObject({
        topic: GuideTopicSchema,
        instructions: z.string().min(1).max(16_000),
      }),
    )
    .min(1)
    .max(7),
});

const SECTIONS: readonly GuideSection[] = [
  { topic: "installation", instructions: INSTALLATION_GUIDE },
  { topic: "hooks", instructions: HOOK_GUIDE },
  { topic: "features", instructions: FEATURES_GUIDE },
  { topic: "encryption", instructions: ENCRYPTION_GUIDE },
  { topic: "orchestration", instructions: ORCHESTRATION_GUIDE },
  { topic: "organizations", instructions: ORGANIZATIONS_GUIDE },
  { topic: "troubleshooting", instructions: TROUBLESHOOTING_GUIDE },
];

export function setupGuideToolDefinition(): Tool {
  return toolDefinition(
    "get_setup_guide",
    "Get complete Murmur setup guide",
    "Get self-contained installation, hook, organization, encryption, and approved orchestrator configuration instructions without repository access. Call this after installing Murmur. The guide also lists the tools actually available to this connection; it does not change configuration or grant authority.",
    SetupGuideInputSchema,
    SetupGuideOutputSchema,
    {
      destructiveHint: false,
      idempotentHint: true,
      readOnlyHint: true,
      title: "Get Murmur setup guide",
    },
  );
}

export function callSetupGuideTool(
  name: string,
  argumentsValue: unknown,
  tools: readonly Tool[],
): CallToolResult | null {
  if (name !== "get_setup_guide") return null;
  const input: SetupGuideInput = SetupGuideInputSchema.parse(
    argumentsValue === undefined ? {} : argumentsValue,
  );
  return toolResult(
    SetupGuideOutputSchema.parse({
      version: packageMetadata.version,
      available_tools: tools.map((tool: Tool): string => tool.name).sort(),
      sections: SECTIONS.filter(
        (section: GuideSection): boolean => input.topic === "all" || section.topic === input.topic,
      ),
    }),
  );
}
