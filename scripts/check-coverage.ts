import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export const MINIMUM_COVERAGE_PERCENT: number = 90;

type MutableCoverageRecord = {
  functionsFound: number | null;
  functionsHit: number | null;
  linesFound: number | null;
  linesHit: number | null;
  source: string;
};

export type CoverageRecord = {
  readonly functionsFound: number;
  readonly functionsHit: number;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly source: string;
};

export type CoverageMetric = {
  readonly found: number;
  readonly hit: number;
  readonly percent: number;
};

export type CoverageAudit = {
  readonly errors: readonly string[];
  readonly functions: CoverageMetric;
  readonly lines: CoverageMetric;
  readonly trackedSources: number;
};

function parseCount(line: string, prefix: string): number {
  const value: string = line.slice(prefix.length);
  if (!/^\d+$/u.test(value)) throw new Error(`Invalid LCOV count '${line}'`);
  return Number.parseInt(value, 10);
}

function normalizeSource(source: string, workspace: string): string {
  const normalizedSource: string = source.replaceAll("\\", "/");
  const normalizedWorkspace: string = workspace.replaceAll("\\", "/").replace(/\/+$/u, "");
  const workspacePrefix: string = `${normalizedWorkspace}/`;
  if (normalizedSource.startsWith(workspacePrefix)) {
    return normalizedSource.slice(workspacePrefix.length);
  }
  return normalizedSource.startsWith("./") ? normalizedSource.slice(2) : normalizedSource;
}

function completedRecord(record: MutableCoverageRecord): CoverageRecord {
  if (
    record.functionsFound === null ||
    record.functionsHit === null ||
    record.linesFound === null ||
    record.linesHit === null
  ) {
    throw new Error(`LCOV record for '${record.source}' is missing coverage totals`);
  }
  if (record.functionsHit > record.functionsFound || record.linesHit > record.linesFound) {
    throw new Error(`LCOV record for '${record.source}' has impossible coverage totals`);
  }
  return {
    functionsFound: record.functionsFound,
    functionsHit: record.functionsHit,
    linesFound: record.linesFound,
    linesHit: record.linesHit,
    source: record.source,
  };
}

export function parseLcov(content: string, workspace: string): readonly CoverageRecord[] {
  const records: CoverageRecord[] = [];
  const sources: Set<string> = new Set<string>();
  let current: MutableCoverageRecord | null = null;
  for (const line of content.split(/\r?\n/gu)) {
    if (line.startsWith("SF:")) {
      if (current !== null) throw new Error("LCOV started a record before ending the prior record");
      const source: string = normalizeSource(line.slice(3), workspace);
      if (source === "") throw new Error("LCOV contains an empty source path");
      current = {
        functionsFound: null,
        functionsHit: null,
        linesFound: null,
        linesHit: null,
        source,
      };
      continue;
    }
    if (line === "end_of_record") {
      if (current === null) throw new Error("LCOV ended a record that was not started");
      const record: CoverageRecord = completedRecord(current);
      if (sources.has(record.source)) {
        throw new Error(`LCOV contains duplicate records for '${record.source}'`);
      }
      sources.add(record.source);
      records.push(record);
      current = null;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("FNF:")) current.functionsFound = parseCount(line, "FNF:");
    if (line.startsWith("FNH:")) current.functionsHit = parseCount(line, "FNH:");
    if (line.startsWith("LF:")) current.linesFound = parseCount(line, "LF:");
    if (line.startsWith("LH:")) current.linesHit = parseCount(line, "LH:");
  }
  if (current !== null) throw new Error(`LCOV record for '${current.source}' was not terminated`);
  return records;
}

function metric(found: number, hit: number): CoverageMetric {
  const percent: number = found === 0 ? 100 : (hit / found) * 100;
  return { found, hit, percent };
}

function metricError(name: string, value: CoverageMetric, minimumPercent: number): string | null {
  if (value.percent > minimumPercent) return null;
  return `${name} coverage must be >${minimumPercent.toFixed(1)}%; received ${value.percent.toFixed(2)}% (${value.hit}/${value.found})`;
}

export function auditCoverage(
  trackedSources: readonly string[],
  lcovContent: string,
  workspace: string,
  minimumPercent: number = MINIMUM_COVERAGE_PERCENT,
): CoverageAudit {
  if (!Number.isFinite(minimumPercent) || minimumPercent < 0 || minimumPercent >= 100) {
    throw new Error("Coverage minimum must be a finite percentage from 0 through 99.999...");
  }
  const normalizedTrackedSources: string[] = trackedSources
    .map((source: string): string => normalizeSource(source, workspace))
    .filter((source: string): boolean => source.startsWith("src/") && source.endsWith(".ts"))
    .sort((left: string, right: string): number => left.localeCompare(right));
  const uniqueTrackedSources: Set<string> = new Set<string>(normalizedTrackedSources);
  if (uniqueTrackedSources.size !== normalizedTrackedSources.length) {
    throw new Error("Tracked source census contains duplicate paths");
  }

  const sourceRecords: Map<string, CoverageRecord> = new Map<string, CoverageRecord>();
  for (const record of parseLcov(lcovContent, workspace)) {
    if (record.source.startsWith("src/") && record.source.endsWith(".ts")) {
      sourceRecords.set(record.source, record);
    }
  }

  const errors: string[] = [];
  const missingSources: string[] = normalizedTrackedSources.filter(
    (source: string): boolean => !sourceRecords.has(source),
  );
  if (missingSources.length > 0) {
    errors.push(`Tracked source files missing from LCOV: ${missingSources.join(", ")}`);
  }
  const untrackedSources: string[] = [...sourceRecords.keys()].filter(
    (source: string): boolean => !uniqueTrackedSources.has(source),
  );
  if (untrackedSources.length > 0) {
    errors.push(`Untracked source files present in LCOV: ${untrackedSources.join(", ")}`);
  }

  let functionsFound: number = 0;
  let functionsHit: number = 0;
  let linesFound: number = 0;
  let linesHit: number = 0;
  for (const source of normalizedTrackedSources) {
    const record: CoverageRecord | undefined = sourceRecords.get(source);
    if (record === undefined) continue;
    functionsFound += record.functionsFound;
    functionsHit += record.functionsHit;
    linesFound += record.linesFound;
    linesHit += record.linesHit;
  }
  const functionMetric: CoverageMetric = metric(functionsFound, functionsHit);
  const lineMetric: CoverageMetric = metric(linesFound, linesHit);
  const functionError: string | null = metricError("Function", functionMetric, minimumPercent);
  const lineError: string | null = metricError("Line", lineMetric, minimumPercent);
  if (functionError !== null) errors.push(functionError);
  if (lineError !== null) errors.push(lineError);
  return {
    errors,
    functions: functionMetric,
    lines: lineMetric,
    trackedSources: normalizedTrackedSources.length,
  };
}

export function trackedRuntimeSources(workspace: string = process.cwd()): readonly string[] {
  const output: string = execFileSync("git", ["ls-files", "-z", "--", "src"], {
    cwd: workspace,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter(
      (source: string): boolean =>
        source.startsWith("src/") &&
        source.endsWith(".ts") &&
        hasRuntimeCode(readFileSync(join(workspace, source), "utf8")),
    );
}

export function hasRuntimeCode(source: string): boolean {
  const transpiler: Bun.Transpiler = new Bun.Transpiler({ loader: "ts" });
  return transpiler.transformSync(source).trim() !== "";
}

export function runCoverageAudit(
  workspace: string = process.cwd(),
  reportPath: string = join(workspace, "coverage", "lcov.info"),
): CoverageAudit {
  if (!existsSync(reportPath)) {
    throw new Error(
      `Coverage report not found at '${reportPath}'; run the full coverage suite first`,
    );
  }
  const lcovContent: string = readFileSync(reportPath, "utf8");
  return auditCoverage(trackedRuntimeSources(workspace), lcovContent, workspace);
}

function formatMetric(name: string, value: CoverageMetric): string {
  return `${name}: ${value.percent.toFixed(2)}% (${value.hit}/${value.found})`;
}

function main(): void {
  try {
    const audit: CoverageAudit = runCoverageAudit();
    process.stdout.write(`${formatMetric("Functions", audit.functions)}\n`);
    process.stdout.write(`${formatMetric("Lines", audit.lines)}\n`);
    if (audit.errors.length > 0) {
      for (const error of audit.errors) process.stderr.write(`Coverage gate: ${error}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Coverage gate passed for ${audit.trackedSources} tracked runtime source files.\n`,
    );
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Coverage gate failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
