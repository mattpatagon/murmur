import { z } from "zod";

export type MurmurUpgradeStatus = "ahead" | "update_available" | "up_to_date";

export type MurmurReleaseMetadata = {
  readonly revision: string;
  readonly version: string;
};

export type MurmurUpgradeStep = {
  readonly command: string | null;
  readonly description: string;
};

export type CheckForUpgradesOutput = {
  readonly checked_at: string;
  readonly current_version: string;
  readonly latest_revision: string;
  readonly latest_version: string;
  readonly status: MurmurUpgradeStatus;
  readonly update_available: boolean;
  readonly upgrade_steps: readonly MurmurUpgradeStep[];
};

export const MurmurVersionSchema: z.ZodString = z
  .string()
  .min(7)
  .max(43)
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);

export const MurmurRevisionSchema: z.ZodString = z.string().regex(/^[a-f0-9]{40}$/u);

export const MurmurReleaseMetadataSchema: z.ZodType<MurmurReleaseMetadata> = z.strictObject({
  revision: MurmurRevisionSchema,
  version: MurmurVersionSchema,
});

export const CheckForUpgradesInputSchema: z.ZodType<Record<string, never>> = z.strictObject({});

const MurmurUpgradeStepSchema: z.ZodType<MurmurUpgradeStep> = z.strictObject({
  command: z.string().min(1).max(1_000).nullable(),
  description: z.string().min(1).max(1_000),
});

export const CheckForUpgradesOutputSchema: z.ZodType<CheckForUpgradesOutput> = z
  .strictObject({
    checked_at: z.iso.datetime({ offset: true }),
    current_version: MurmurVersionSchema,
    latest_revision: MurmurRevisionSchema,
    latest_version: MurmurVersionSchema,
    status: z.enum(["ahead", "update_available", "up_to_date"]),
    update_available: z.boolean(),
    upgrade_steps: z.array(MurmurUpgradeStepSchema).length(3),
  })
  .superRefine((output: CheckForUpgradesOutput, context: z.core.$RefinementCtx): void => {
    const comparison: number = compareMurmurVersions(output.current_version, output.latest_version);
    const expectedStatus: MurmurUpgradeStatus =
      comparison < 0 ? "update_available" : comparison > 0 ? "ahead" : "up_to_date";
    if (output.status !== expectedStatus) {
      context.addIssue({ code: "custom", message: "Murmur upgrade status is inconsistent" });
    }
    if (output.update_available !== (expectedStatus === "update_available")) {
      context.addIssue({
        code: "custom",
        message: "Murmur upgrade availability is inconsistent",
      });
    }
  });

function versionParts(version: string): readonly number[] {
  const parsed: string = MurmurVersionSchema.parse(version);
  return parsed.split(".").map((part: string): number => {
    const value: number = Number(part);
    if (!Number.isSafeInteger(value)) throw new Error("Murmur version component is too large");
    return value;
  });
}

export function compareMurmurVersions(current: string, latest: string): number {
  const currentParts: readonly number[] = versionParts(current);
  const latestParts: readonly number[] = versionParts(latest);
  for (let index: number = 0; index < 4; index += 1) {
    const currentPart: number | undefined = currentParts[index];
    const latestPart: number | undefined = latestParts[index];
    if (currentPart === undefined || latestPart === undefined) {
      throw new Error("Murmur version must contain four components");
    }
    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }
  return 0;
}

export function createUpgradeCheckOutput(
  currentVersion: string,
  latestVersion: string,
  latestRevision: string,
  checkedAt: Date,
): CheckForUpgradesOutput {
  const current: string = MurmurVersionSchema.parse(currentVersion);
  const latest: string = MurmurVersionSchema.parse(latestVersion);
  const revision: string = MurmurRevisionSchema.parse(latestRevision);
  const comparison: number = compareMurmurVersions(current, latest);
  const status: MurmurUpgradeStatus =
    comparison < 0 ? "update_available" : comparison > 0 ? "ahead" : "up_to_date";
  return CheckForUpgradesOutputSchema.parse({
    checked_at: checkedAt.toISOString(),
    current_version: current,
    latest_revision: revision,
    latest_version: latest,
    status,
    update_available: status === "update_available",
    upgrade_steps: [
      {
        command: `bun install --global 'git+https://github.com/mattpatagon/murmur.git#${revision}'`,
        description: "Install the exact latest Murmur revision globally.",
      },
      {
        command: "murmur setup --user",
        description:
          "Refresh standard user configuration. If E2E is enabled, run `murmur setup --user --e2ee` instead.",
      },
      {
        command: null,
        description:
          "Restart active Codex and Claude sessions so they load the upgraded tools and hooks.",
      },
    ],
  });
}
