import { describe, expect, test } from "bun:test";

import { auditDependencyPolicy, type BunPinSurfaces } from "../scripts/check-dependencies.js";

const VALID_BUNFIG: string = `[install]
minimumReleaseAge = 259200

[test]
coverageSkipTestFiles = true
`;

const VALID_BUN_PIN_SURFACES: BunPinSurfaces = {
  ciWorkflow: "bun-version: 1.3.14\n",
  deployWorkflow: "bun-version: 1.3.14\n",
  dockerfile: "FROM oven/bun:1.3.14\nFROM oven/bun:1.3.14\n",
  productionSmokeWorkflow: "bun-version: 1.3.14\n",
};

function manifest(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    dependencies: { zod: "4.4.3" },
    devDependencies: { typescript: "7.0.2" },
    license: "MIT",
    overrides: { zod: "4.4.3" },
    packageManager: "bun@1.3.14",
    engines: { bun: ">=1.3.14" },
    scripts: { "test:linux": "MURMUR_TEST_DOCKER_IMAGE=oven/bun:1.3.14 bun test" },
    ...overrides,
  });
}

function audit(
  packageJsonText: string,
  bunfigText: string,
  surfaces: BunPinSurfaces = VALID_BUN_PIN_SURFACES,
): readonly string[] {
  return auditDependencyPolicy(packageJsonText, bunfigText, surfaces);
}

describe("dependency policy", (): void => {
  test("accepts exact versions and a 72-hour package quarantine", (): void => {
    expect(audit(manifest(), VALID_BUNFIG)).toEqual([]);
  });

  test("rejects version ranges, aliases, and mutable dependency references", (): void => {
    const cases: readonly string[] = [
      "^4.4.3",
      "~4.4.3",
      ">=4.4.3",
      "latest",
      "workspace:*",
      "git+https://example.invalid/dependency.git",
    ];
    cases.forEach((version: string): void => {
      const errors: readonly string[] = audit(
        manifest({ dependencies: { unsafe: version } }),
        VALID_BUNFIG,
      );
      expect(
        errors.some((error: string): boolean => error.includes("exact semantic version")),
      ).toBe(true);
    });
    expect(
      audit(manifest({ optionalDependencies: { unsafe: "^1.0.0" } }), VALID_BUNFIG),
    ).not.toEqual([]);
    expect(audit(manifest({ peerDependencies: { unsafe: "*" } }), VALID_BUNFIG)).not.toEqual([]);
  });

  test("rejects the wrong license, package manager, or release age", (): void => {
    expect(audit(manifest({ license: "Elastic-2.0" }), VALID_BUNFIG)).not.toEqual([]);
    expect(audit(manifest({ packageManager: "bun@latest" }), VALID_BUNFIG)).not.toEqual([]);
    expect(audit(manifest(), "[install]\nminimumReleaseAge = 86400\n")).toEqual([
      "minimumReleaseAge must be 259200 seconds (72 hours); received 86400",
    ]);
  });

  test("rejects missing, duplicated, misplaced, and interpolated release ages", (): void => {
    const releaseAgeLine: string = "minimumReleaseAge = 259200\n";
    const invalidBunfigs: readonly string[] = [
      "[install]\n",
      `[test]\n${releaseAgeLine}`,
      `[install]\n${releaseAgeLine}${releaseAgeLine}`,
      `[install]\nminimumReleaseAge = ${"$"}{RELEASE_AGE}\n`,
    ];
    invalidBunfigs.forEach((bunfig: string): void => {
      expect(audit(manifest(), bunfig)).not.toEqual([]);
    });
  });

  test("rejects drift between package, container, and workflow Bun pins", (): void => {
    expect(audit(manifest({ engines: { bun: ">=1.3.10" } }), VALID_BUNFIG)).not.toEqual([]);
    expect(
      audit(
        manifest({ scripts: { "test:linux": "MURMUR_TEST_DOCKER_IMAGE=oven/bun:1.3.10" } }),
        VALID_BUNFIG,
      ),
    ).not.toEqual([]);
    expect(
      audit(manifest(), VALID_BUNFIG, {
        ...VALID_BUN_PIN_SURFACES,
        dockerfile: "FROM oven/bun:1.3.10\nFROM oven/bun:1.3.10\n",
      }),
    ).not.toEqual([]);
    expect(
      audit(manifest(), VALID_BUNFIG, {
        ...VALID_BUN_PIN_SURFACES,
        ciWorkflow: "bun-version: 1.3.10\n",
      }),
    ).not.toEqual([]);
    expect(
      audit(manifest(), VALID_BUNFIG, {
        ...VALID_BUN_PIN_SURFACES,
        deployWorkflow: "bun-version: 1.3.10\n",
      }),
    ).not.toEqual([]);
  });

  test("rejects Bun pins that only share the expected version prefix", (): void => {
    expect(
      audit(
        manifest({
          scripts: { "test:linux": "MURMUR_TEST_DOCKER_IMAGE=oven/bun:1.3.140 bun test" },
        }),
        VALID_BUNFIG,
      ),
    ).not.toEqual([]);
    expect(
      audit(manifest(), VALID_BUNFIG, {
        ...VALID_BUN_PIN_SURFACES,
        dockerfile: "FROM oven/bun:1.3.14-alpine\nFROM oven/bun:1.3.14-alpine\n",
      }),
    ).not.toEqual([]);
    expect(
      audit(manifest(), VALID_BUNFIG, {
        ...VALID_BUN_PIN_SURFACES,
        ciWorkflow: "bun-version: 1.3.14\nbun-version: 1.3.14-canary\n",
      }),
    ).not.toEqual([]);
    expect(
      audit(manifest(), VALID_BUNFIG, {
        ...VALID_BUN_PIN_SURFACES,
        deployWorkflow: "bun-version: 1.3.141\n",
      }),
    ).not.toEqual([]);
  });

  test("rejects absent, drifting, and mixed production smoke Bun pins", (): void => {
    const invalidWorkflows: readonly string[] = [
      "",
      "bun-version: 1.3.11\n",
      "bun-version: 1.3.14\nbun-version: 1.3.14-canary\n",
    ];
    for (const productionSmokeWorkflow of invalidWorkflows) {
      expect(
        audit(manifest(), VALID_BUNFIG, {
          ...VALID_BUN_PIN_SURFACES,
          productionSmokeWorkflow,
        }),
      ).toEqual([
        ".github/workflows/production-smoke.yml must install the pinned Bun release '1.3.14'",
      ]);
    }
  });
});
