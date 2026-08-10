import { readFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

import { compareText } from "./lib/deterministic-order.js";

const REQUIRED_MINIMUM_RELEASE_AGE_SECONDS: number = 259_200;
const EXACT_SEMVER: RegExp =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u;

const PackageManifestSchema: z.ZodObject<{
  dependencies: z.ZodRecord<z.ZodString, z.ZodString>;
  devDependencies: z.ZodRecord<z.ZodString, z.ZodString>;
  license: z.ZodLiteral<"Elastic-2.0">;
  optionalDependencies: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
  overrides: z.ZodRecord<z.ZodString, z.ZodString>;
  packageManager: z.ZodString;
  peerDependencies: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}> = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  license: z.literal("Elastic-2.0"),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
  overrides: z.record(z.string(), z.string()),
  packageManager: z.string(),
  peerDependencies: z.record(z.string(), z.string()).default({}),
});

type DependencySections = {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly overrides: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
};

function auditVersions(
  section: string,
  dependencies: Readonly<Record<string, string>>,
  errors: string[],
): void {
  Object.entries(dependencies)
    .sort((left: [string, string], right: [string, string]): number =>
      compareText(left[0], right[0]),
    )
    .forEach((entry: [string, string]): void => {
      if (!EXACT_SEMVER.test(entry[1])) {
        errors.push(
          `${section}.${entry[0]} must use an exact semantic version; received '${entry[1]}'`,
        );
      }
    });
}

function auditBunConfiguration(bunfigText: string, errors: string[]): void {
  const lines: readonly string[] = bunfigText.split(/\r\n|\r|\n/gu);
  let inInstallSection: boolean = false;
  let releaseAgeCount: number = 0;
  lines.forEach((line: string): void => {
    const trimmed: string = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inInstallSection = trimmed === "[install]";
      return;
    }
    if (!trimmed.startsWith("minimumReleaseAge")) return;
    releaseAgeCount += 1;
    if (!inInstallSection) {
      errors.push("minimumReleaseAge must be declared inside bunfig.toml's [install] section");
      return;
    }
    const match: RegExpMatchArray | null = trimmed.match(/^minimumReleaseAge\s*=\s*(\d+)$/u);
    if (match === null) {
      errors.push("minimumReleaseAge must be a bare integer with no interpolation");
      return;
    }
    const rawValue: string | undefined = match[1];
    if (rawValue === undefined) throw new Error("The minimumReleaseAge parser lost its capture");
    const value: number = Number(rawValue);
    if (value !== REQUIRED_MINIMUM_RELEASE_AGE_SECONDS) {
      errors.push(
        `minimumReleaseAge must be ${REQUIRED_MINIMUM_RELEASE_AGE_SECONDS} seconds (72 hours); received ${value}`,
      );
    }
  });
  if (releaseAgeCount === 0) errors.push("bunfig.toml must declare [install].minimumReleaseAge");
  if (releaseAgeCount > 1) errors.push("bunfig.toml must declare minimumReleaseAge exactly once");
}

export function auditDependencyPolicy(
  packageJsonText: string,
  bunfigText: string,
): readonly string[] {
  const errors: string[] = [];
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    return [`package.json is not valid JSON: ${detail}`];
  }
  const parsed: ReturnType<typeof PackageManifestSchema.safeParse> =
    PackageManifestSchema.safeParse(packageJson);
  if (!parsed.success) {
    errors.push(
      `package.json dependency policy fields are invalid: ${z.prettifyError(parsed.error)}`,
    );
  } else {
    const sections: DependencySections = parsed.data;
    const packageManagerPrefix: string = "bun@";
    const packageManagerVersion: string = parsed.data.packageManager.startsWith(
      packageManagerPrefix,
    )
      ? parsed.data.packageManager.slice(packageManagerPrefix.length)
      : "";
    if (!EXACT_SEMVER.test(packageManagerVersion)) {
      errors.push(
        `packageManager must pin one exact Bun release; received '${parsed.data.packageManager}'`,
      );
    }
    auditVersions("dependencies", sections.dependencies, errors);
    auditVersions("devDependencies", sections.devDependencies, errors);
    auditVersions("optionalDependencies", sections.optionalDependencies, errors);
    auditVersions("overrides", sections.overrides, errors);
    auditVersions("peerDependencies", sections.peerDependencies, errors);
  }
  auditBunConfiguration(bunfigText, errors);
  return errors.sort(compareText);
}

function main(): void {
  try {
    const packageJsonText: string = readFileSync("package.json", "utf8");
    const bunfigText: string = readFileSync("bunfig.toml", "utf8");
    const errors: readonly string[] = auditDependencyPolicy(packageJsonText, bunfigText);
    if (errors.length > 0) {
      errors.forEach((error: string): void => {
        process.stderr.write(`Dependency policy: ${error}\n`);
      });
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      "Dependency policy passed: exact versions, frozen Bun release, ELv2 metadata, and 72-hour package quarantine.\n",
    );
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Dependency policy failed: ${detail}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
