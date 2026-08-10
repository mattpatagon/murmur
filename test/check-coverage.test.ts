import { expect, test } from "bun:test";

import { auditCoverage, type CoverageAudit, hasRuntimeCode } from "../scripts/check-coverage.js";

function record(options: {
  readonly functionsFound: number;
  readonly functionsHit: number;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly source: string;
}): string {
  return [
    "TN:",
    `SF:${options.source}`,
    `FNF:${options.functionsFound}`,
    `FNH:${options.functionsHit}`,
    `LF:${options.linesFound}`,
    `LH:${options.linesHit}`,
    "end_of_record",
    "",
  ].join("\n");
}

test("accepts complete tracked-source coverage strictly above ninety percent", (): void => {
  const lcov: string =
    record({
      functionsFound: 50,
      functionsHit: 46,
      linesFound: 50,
      linesHit: 46,
      source: "src/alpha.ts",
    }) +
    record({
      functionsFound: 50,
      functionsHit: 46,
      linesFound: 50,
      linesHit: 46,
      source: "src/beta.ts",
    });
  const audit: CoverageAudit = auditCoverage(["src/alpha.ts", "src/beta.ts"], lcov, "/workspace");
  expect(audit.errors).toEqual([]);
  expect(audit.functions.percent).toBe(92);
  expect(audit.lines.percent).toBe(92);
});

test("fails when a tracked source file is absent from lcov", (): void => {
  const lcov: string = record({
    functionsFound: 10,
    functionsHit: 10,
    linesFound: 10,
    linesHit: 10,
    source: "src/loaded.ts",
  });
  const audit: CoverageAudit = auditCoverage(
    ["src/loaded.ts", "src/unimported.ts"],
    lcov,
    "/workspace",
  );
  expect(audit.errors).toContain("Tracked source files missing from LCOV: src/unimported.ts");
});

test("excludes erased type declarations but keeps executable TypeScript in the census", (): void => {
  expect(hasRuntimeCode("export type Identifier = string;\n")).toBeFalse();
  expect(hasRuntimeCode("export interface Message { readonly body: string; }\n")).toBeFalse();
  expect(hasRuntimeCode("export const retentionDays: number = 30;\n")).toBeTrue();
});

test("rejects non-TypeScript files from the tracked source census", (): void => {
  expect(
    (): CoverageAudit =>
      auditCoverage(
        ["src/tracked.ts", "src/bypass.js"],
        record({
          functionsFound: 1,
          functionsHit: 1,
          linesFound: 1,
          linesHit: 1,
          source: "src/tracked.ts",
        }),
        "/workspace",
      ),
  ).toThrow("Only .ts files are permitted under src");
});

test("rejects exactly ninety percent and untracked source records", (): void => {
  const lcov: string =
    record({
      functionsFound: 10,
      functionsHit: 9,
      linesFound: 10,
      linesHit: 9,
      // biome-ignore lint/security/noSecrets: This synthetic Windows path exercises normalization.
      source: "C:\\WORKSPACE\\src\\tracked.ts",
    }) +
    record({
      functionsFound: 1,
      functionsHit: 1,
      linesFound: 1,
      linesHit: 1,
      source: "src/untracked.ts",
    });
  const audit: CoverageAudit = auditCoverage(["src/tracked.ts"], lcov, "C:\\workspace");
  expect(audit.errors).toContain("Untracked source files present in LCOV: src/untracked.ts");
  expect(audit.errors).toContain("Function coverage must be >90.0%; received 90.00% (9/10)");
  expect(audit.errors).toContain("Line coverage must be >90.0%; received 90.00% (9/10)");
});

test("rejects a source file at the per-file floor even when aggregate coverage passes", (): void => {
  const lcov: string =
    record({
      functionsFound: 5,
      functionsHit: 4,
      linesFound: 5,
      linesHit: 4,
      source: "src/weak.ts",
    }) +
    record({
      functionsFound: 95,
      functionsHit: 95,
      linesFound: 95,
      linesHit: 95,
      source: "src/strong.ts",
    });
  const audit: CoverageAudit = auditCoverage(["src/weak.ts", "src/strong.ts"], lcov, "/workspace");
  expect(audit.functions.percent).toBe(99);
  expect(audit.lines.percent).toBe(99);
  expect(audit.errors).toContain("src/weak.ts line coverage must be >80.0%; received 80.00% (4/5)");
});

test("rejects malformed or duplicate lcov records", (): void => {
  const valid: string = record({
    functionsFound: 1,
    functionsHit: 1,
    linesFound: 1,
    linesHit: 1,
    source: "src/duplicate.ts",
  });
  expect(
    (): CoverageAudit => auditCoverage(["src/duplicate.ts"], `${valid}${valid}`, "/workspace"),
  ).toThrow("duplicate records");
  expect(
    (): CoverageAudit =>
      auditCoverage(
        ["src/malformed.ts"],
        "SF:src/malformed.ts\nFNF:wat\nFNH:0\nLF:1\nLH:1\nend_of_record\n",
        "/workspace",
      ),
  ).toThrow("Invalid LCOV count");
});
