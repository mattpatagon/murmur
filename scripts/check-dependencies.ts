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
  engines: z.ZodObject<{ bun: z.ZodString }>;
  license: z.ZodLiteral<"MIT">;
  optionalDependencies: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
  overrides: z.ZodRecord<z.ZodString, z.ZodString>;
  packageManager: z.ZodString;
  peerDependencies: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
  scripts: z.ZodRecord<z.ZodString, z.ZodString>;
}> = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  engines: z.object({ bun: z.string() }),
  license: z.literal("MIT"),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
  overrides: z.record(z.string(), z.string()),
  packageManager: z.string(),
  peerDependencies: z.record(z.string(), z.string()).default({}),
  scripts: z.record(z.string(), z.string()),
});

export type BunPinSurfaces = {
  readonly ciWorkflow: string;
  readonly deployWorkflow: string;
  readonly dockerfile: string;
  readonly productionSmokeWorkflow: string;
};

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

function textLines(contents: string): readonly string[] {
  return contents.split(/\r\n|\r|\n/gu).map((line: string): string => line.trim());
}

function shellAssignmentValues(contents: string, name: string): readonly string[] {
  const prefix: string = `${name}=`;
  return contents
    .split(/\s+/gu)
    .filter((token: string): boolean => token.startsWith(prefix))
    .map((token: string): string => token.slice(prefix.length));
}

function dockerBunImages(contents: string): readonly string[] {
  const prefix: string = "FROM oven/bun:";
  return textLines(contents)
    .filter((line: string): boolean => line.startsWith(prefix))
    .map((line: string): string => {
      const image: string | undefined = line.split(/\s+/gu)[1];
      if (image === undefined) throw new Error("Dockerfile Bun stage lost its image token");
      return image;
    });
}

function workflowBunVersions(contents: string): readonly string[] {
  const prefix: string = "bun-version:";
  return textLines(contents)
    .filter((line: string): boolean => line.startsWith(prefix))
    .map((line: string): string => {
      const valueWithComment: string = line.slice(prefix.length).trim();
      const value: string | undefined = valueWithComment.split("#")[0];
      if (value === undefined) throw new Error("Workflow Bun pin lost its scalar value");
      const unquoted: string = value.trim();
      const quoted: boolean =
        (unquoted.startsWith('"') && unquoted.endsWith('"')) ||
        (unquoted.startsWith("'") && unquoted.endsWith("'"));
      return quoted ? unquoted.slice(1, -1) : unquoted;
    });
}

function auditBunPins(
  packageManagerVersion: string,
  engineVersion: string,
  testLinux: string | undefined,
  surfaces: BunPinSurfaces,
  errors: string[],
): void {
  const expectedEngine: string = `>=${packageManagerVersion}`;
  if (engineVersion !== expectedEngine) {
    errors.push(
      `engines.bun must declare compatibility from the pinned Bun release '${expectedEngine}'; ` +
        `received '${engineVersion}'`,
    );
  }

  const expectedImage: string = `oven/bun:${packageManagerVersion}`;
  const testLinuxImages: readonly string[] =
    testLinux === undefined ? [] : shellAssignmentValues(testLinux, "MURMUR_TEST_DOCKER_IMAGE");
  if (testLinuxImages.length !== 1 || testLinuxImages[0] !== expectedImage) {
    errors.push(`scripts.test:linux must use the pinned Bun image '${expectedImage}' exactly once`);
  }

  const dockerImages: readonly string[] = dockerBunImages(surfaces.dockerfile);
  if (
    dockerImages.length !== 2 ||
    !dockerImages.every((image: string): boolean => image === expectedImage)
  ) {
    errors.push(`Dockerfile must use the pinned Bun image '${expectedImage}' in both stages`);
  }

  const workflows: readonly [string, string][] = [
    [".github/workflows/ci.yml", surfaces.ciWorkflow],
    [".github/workflows/deploy.yml", surfaces.deployWorkflow],
    [".github/workflows/production-smoke.yml", surfaces.productionSmokeWorkflow],
  ];
  workflows.forEach((entry: readonly [string, string]): void => {
    const workflowVersions: readonly string[] = workflowBunVersions(entry[1]);
    if (
      workflowVersions.length === 0 ||
      !workflowVersions.every((version: string): boolean => version === packageManagerVersion)
    ) {
      errors.push(`${entry[0]} must install the pinned Bun release '${packageManagerVersion}'`);
    }
  });
}

export function auditDependencyPolicy(
  packageJsonText: string,
  bunfigText: string,
  bunPinSurfaces: BunPinSurfaces,
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
    } else {
      auditBunPins(
        packageManagerVersion,
        parsed.data.engines.bun,
        parsed.data.scripts["test:linux"],
        bunPinSurfaces,
        errors,
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

export function auditWebsiteDependencyPolicy(
  rootPackageJsonText: string,
  websitePackageJsonText: string,
  websiteBunfigText: string,
  websiteWorkflow: string,
): readonly string[] {
  const errors: string[] = [];
  let rootPackage: unknown;
  let websitePackage: unknown;
  try {
    rootPackage = JSON.parse(rootPackageJsonText);
  } catch {
    return ["package.json must be valid JSON before validating website toolchain parity"];
  }
  try {
    websitePackage = JSON.parse(websitePackageJsonText);
  } catch {
    return ["website/package.json is not valid JSON"];
  }
  const root: ReturnType<typeof PackageManifestSchema.safeParse> =
    PackageManifestSchema.safeParse(rootPackage);
  const website: ReturnType<typeof PackageManifestSchema.safeParse> =
    PackageManifestSchema.safeParse(websitePackage);
  if (!root.success || !root.data.packageManager.startsWith("bun@")) {
    return ["package.json must declare its Bun toolchain before validating website parity"];
  }
  const rootBunVersion: string = root.data.packageManager.slice(4);
  if (!EXACT_SEMVER.test(rootBunVersion)) {
    return ["package.json must pin an exact Bun release before validating website parity"];
  }
  if (!website.success) {
    errors.push(
      "website/package.json dependency policy fields are invalid; require MIT metadata and dependency sections",
    );
  } else {
    const sections: DependencySections = website.data;
    const versionErrors: string[] = [];
    auditVersions("dependencies", sections.dependencies, versionErrors);
    auditVersions("devDependencies", sections.devDependencies, versionErrors);
    auditVersions("optionalDependencies", sections.optionalDependencies, versionErrors);
    auditVersions("overrides", sections.overrides, versionErrors);
    auditVersions("peerDependencies", sections.peerDependencies, versionErrors);
    for (const error of versionErrors) errors.push(`website/package.json: ${error}`);
    if (website.data.packageManager !== root.data.packageManager) {
      errors.push(
        `website/package.json packageManager must match the root pin 'bun@${rootBunVersion}'`,
      );
    }
    if (website.data.engines.bun !== `>=${rootBunVersion}`) {
      errors.push(
        `website/package.json engines.bun must declare compatibility from '>=${rootBunVersion}'`,
      );
    }
  }
  const configurationErrors: string[] = [];
  auditBunConfiguration(websiteBunfigText, configurationErrors);
  for (const error of configurationErrors) errors.push(`website/bunfig.toml: ${error}`);
  const workflowVersions: readonly string[] = workflowBunVersions(websiteWorkflow);
  if (
    workflowVersions.length === 0 ||
    !workflowVersions.every((version: string): boolean => version === rootBunVersion)
  ) {
    errors.push(
      `.github/workflows/website.yml must install the pinned Bun release '${rootBunVersion}'`,
    );
  }
  return errors.sort(compareText);
}

function main(): void {
  try {
    const packageJsonText: string = readFileSync("package.json", "utf8");
    const bunfigText: string = readFileSync("bunfig.toml", "utf8");
    const bunPinSurfaces: BunPinSurfaces = {
      ciWorkflow: readFileSync(".github/workflows/ci.yml", "utf8"),
      deployWorkflow: readFileSync(".github/workflows/deploy.yml", "utf8"),
      dockerfile: readFileSync("Dockerfile", "utf8"),
      productionSmokeWorkflow: readFileSync(".github/workflows/production-smoke.yml", "utf8"),
    };
    const errors: readonly string[] = [
      ...auditDependencyPolicy(packageJsonText, bunfigText, bunPinSurfaces),
      ...auditWebsiteDependencyPolicy(
        packageJsonText,
        readFileSync("website/package.json", "utf8"),
        readFileSync("website/bunfig.toml", "utf8"),
        readFileSync(".github/workflows/website.yml", "utf8"),
      ),
    ].sort(compareText);
    if (errors.length > 0) {
      errors.forEach((error: string): void => {
        process.stderr.write(`Dependency policy: ${error}\n`);
      });
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      "Dependency policy passed for runtime and website: exact versions, synchronized Bun pins, MIT metadata, and 72-hour package quarantine.\n",
    );
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Dependency policy failed: ${detail}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
