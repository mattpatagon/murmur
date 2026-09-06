import { describe, expect, test } from "bun:test";

import {
  auditDependencyPolicy,
  auditWebsiteDependencyPolicy,
  type BunPinSurfaces,
} from "../scripts/check-dependencies.js";

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

function websiteManifest(overrides: Readonly<Record<string, unknown>> = {}): string {
  return manifest({
    devDependencies: { astro: "6.3.8", typescript: "6.0.3" },
    scripts: { build: "astro build" },
    ...overrides,
  });
}

function auditWebsite(
  packageJsonText: string = websiteManifest(),
  bunfigText: string = VALID_BUNFIG,
  workflow: string = "bun-version: 1.3.14\n",
): readonly string[] {
  return auditWebsiteDependencyPolicy(manifest(), packageJsonText, bunfigText, workflow);
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

describe("isolated website dependency policy", (): void => {
  test("accepts a compatible independent compiler without imposing runtime Docker scripts", (): void => {
    expect(auditWebsite()).toEqual([]);
    expect(auditWebsite(websiteManifest({ dependencies: {}, overrides: {}, scripts: {} }))).toEqual(
      [],
    );
  });

  test("requires exact versions across every website dependency section", (): void => {
    const sections: readonly string[] = [
      "dependencies",
      "devDependencies",
      "overrides",
      "optionalDependencies",
      "peerDependencies",
    ];
    const references: readonly string[] = [
      "^1.2.3",
      "latest",
      "workspace:*",
      "npm:typescript@6.0.3",
    ];
    for (const section of sections) {
      for (const reference of references) {
        const errors: readonly string[] = auditWebsite(
          websiteManifest({ [section]: { unsafe: reference } }),
        );
        expect(errors).toEqual([
          `website/package.json: ${section}.unsafe must use an exact semantic version; received '${reference}'`,
        ]);
      }
    }
  });

  test("requires MIT metadata and a structurally valid nested manifest", (): void => {
    expect(auditWebsite(websiteManifest({ license: "Elastic-2.0" }))).not.toEqual([]);
    expect(auditWebsite(websiteManifest({ dependencies: undefined }))).not.toEqual([]);
    expect(auditWebsite("{")).toEqual(["website/package.json is not valid JSON"]);
    expect(
      auditWebsiteDependencyPolicy("{", websiteManifest(), VALID_BUNFIG, "bun-version: 1.3.14\n"),
    ).toEqual(["package.json must be valid JSON before validating website toolchain parity"]);
  });

  test("rejects website Bun drift and nonexact toolchain references", (): void => {
    for (const packageManager of ["bun@1.3.13", "bun@1.3.140", "bun@latest", "npm@1.3.14"]) {
      expect(auditWebsite(websiteManifest({ packageManager }))).toContain(
        "website/package.json packageManager must match the root pin 'bun@1.3.14'",
      );
    }
    expect(auditWebsite(websiteManifest({ engines: { bun: ">=1.3.10" } }))).toContain(
      "website/package.json engines.bun must declare compatibility from '>=1.3.14'",
    );
  });

  test("derives website parity from the reviewed root Bun pin", (): void => {
    const toolchain: Readonly<Record<string, unknown>> = {
      engines: { bun: ">=1.4.0" },
      packageManager: "bun@1.4.0",
    };
    expect(
      auditWebsiteDependencyPolicy(
        manifest(toolchain),
        websiteManifest(toolchain),
        VALID_BUNFIG,
        "bun-version: 1.4.0\n",
      ),
    ).toEqual([]);
    expect(
      auditWebsiteDependencyPolicy(
        manifest({ packageManager: "bun@latest" }),
        websiteManifest(),
        VALID_BUNFIG,
        "bun-version: 1.3.14\n",
      ),
    ).not.toEqual([]);
  });

  test("rejects absent, drifting, or mixed website workflow pins", (): void => {
    for (const workflow of [
      "",
      "bun-version: 1.3.13\n",
      "bun-version: 1.3.14\nbun-version: 1.3.14-canary\n",
    ]) {
      expect(auditWebsite(websiteManifest(), VALID_BUNFIG, workflow)).toEqual([
        ".github/workflows/website.yml must install the pinned Bun release '1.3.14'",
      ]);
    }
    expect(
      auditWebsite(websiteManifest(), VALID_BUNFIG, "bun-version: '1.3.14' # pinned\n"),
    ).toEqual([]);
  });

  test("enforces the separate 72-hour quarantine without accepting misplaced or repeated values", (): void => {
    const invalid: readonly string[] = [
      "[install]\n",
      "[install]\nminimumReleaseAge = 0\n",
      "[test]\nminimumReleaseAge = 259200\n",
      ["[install]", "minimumReleaseAge = 259200", "minimumReleaseAge = 259200", ""].join("\n"),
    ];
    for (const bunfig of invalid) {
      const errors: readonly string[] = auditWebsite(websiteManifest(), bunfig);
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.every((error: string): boolean => error.startsWith("website/bunfig.toml:")),
      ).toBe(true);
    }
  });
});
