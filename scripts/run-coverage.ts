import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

function resetCoverageDirectory(workspace: string): void {
  const normalizedWorkspace: string = resolve(workspace);
  const coverageDirectory: string = resolve(normalizedWorkspace, "coverage");
  if (
    basename(coverageDirectory) !== "coverage" ||
    dirname(coverageDirectory) !== normalizedWorkspace
  ) {
    throw new Error(`Refusing to clear unexpected coverage path '${coverageDirectory}'`);
  }
  rmSync(coverageDirectory, { force: true, recursive: true });
}

function runBun(arguments_: readonly string[], workspace: string): boolean {
  try {
    execFileSync(process.execPath, arguments_, {
      cwd: workspace,
      env: process.env,
      stdio: "inherit",
    });
    return true;
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Coverage command failed: ${message}\n`);
    return false;
  }
}

function main(): void {
  try {
    const workspace: string = process.cwd();
    resetCoverageDirectory(workspace);
    const configurationPath: string = join(workspace, "bunfig.coverage.toml");
    const testsPassed: boolean = runBun([`--config=${configurationPath}`, "test"], workspace);
    if (!testsPassed) {
      process.exitCode = 1;
      return;
    }
    const auditPassed: boolean = runBun(["run", "scripts/check-coverage.ts"], workspace);
    if (!auditPassed) process.exitCode = 1;
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Coverage gate failed: ${message}\n`);
    process.exitCode = 1;
  }
}

main();
