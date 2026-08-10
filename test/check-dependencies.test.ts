import { describe, expect, test } from "bun:test";

import { auditDependencyPolicy } from "../scripts/check-dependencies.js";

const VALID_BUNFIG: string = `[install]
minimumReleaseAge = 259200

[test]
coverageSkipTestFiles = true
`;

function manifest(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    dependencies: { zod: "4.4.3" },
    devDependencies: { typescript: "7.0.2" },
    license: "Elastic-2.0",
    overrides: { zod: "4.4.3" },
    packageManager: "bun@1.3.11",
    ...overrides,
  });
}

describe("dependency policy", (): void => {
  test("accepts exact versions and a 72-hour package quarantine", (): void => {
    expect(auditDependencyPolicy(manifest(), VALID_BUNFIG)).toEqual([]);
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
      const errors: readonly string[] = auditDependencyPolicy(
        manifest({ dependencies: { unsafe: version } }),
        VALID_BUNFIG,
      );
      expect(
        errors.some((error: string): boolean => error.includes("exact semantic version")),
      ).toBe(true);
    });
    expect(
      auditDependencyPolicy(manifest({ optionalDependencies: { unsafe: "^1.0.0" } }), VALID_BUNFIG),
    ).not.toEqual([]);
    expect(
      auditDependencyPolicy(manifest({ peerDependencies: { unsafe: "*" } }), VALID_BUNFIG),
    ).not.toEqual([]);
  });

  test("rejects the wrong license, package manager, or release age", (): void => {
    expect(auditDependencyPolicy(manifest({ license: "MIT" }), VALID_BUNFIG)).not.toEqual([]);
    expect(
      auditDependencyPolicy(manifest({ packageManager: "bun@latest" }), VALID_BUNFIG),
    ).not.toEqual([]);
    expect(auditDependencyPolicy(manifest(), "[install]\nminimumReleaseAge = 86400\n")).toEqual([
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
      expect(auditDependencyPolicy(manifest(), bunfig)).not.toEqual([]);
    });
  });
});
