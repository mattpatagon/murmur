import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";

type SafetyResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

const SAFETY_SCRIPT: string = resolve("scripts/check-safety.ts");
const PROJECT_CONFIGURATION: string = JSON.stringify(
  {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2023",
    },
    include: ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "other/**/*.ts"],
  },
  null,
  2,
);

function createWorkspace(files: Readonly<Record<string, string>>): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "murmur-safety-gate-"));
  writeFileSync(join(workspace, "tsconfig.test.json"), `${PROJECT_CONFIGURATION}\n`);
  Object.entries(files).forEach((entry: [string, string]): void => {
    const path: string = join(workspace, entry[0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry[1]);
  });
  return workspace;
}

async function runSafety(workspace: string): Promise<SafetyResult> {
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, "run", SAFETY_SCRIPT],
    {
      cwd: workspace,
      env: { PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout]: [number, string, string] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

test("safety gate accepts fully explicit TypeScript", async (): Promise<void> => {
  const workspace: string = createWorkspace({
    "src/server.ts": [
      "export const ready: boolean = true;",
      "export function identity(value: string): string {",
      "  return value;",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const result: SafetyResult = await runSafety(workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Safety contract passed for 1 TypeScript files.");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("safety gate rejects every TypeScript escape hatch", async (): Promise<void> => {
  const expectErrorSuppression: string = "// @ts-" + "expect-error";
  const ignoreSuppression: string = "// @ts-" + "ignore";
  const noCheckSuppression: string = "// @ts-" + "nocheck";
  const workspace: string = createWorkspace({
    "src/server.ts": "export const ready: boolean = true;\n",
    "test/expect-error.ts": `${expectErrorSuppression}\nconst value: number = 'invalid';\n`,
    "test/ignore.ts": `${ignoreSuppression}\nconst value: number = 'invalid';\n`,
    "test/nocheck.ts": `${noCheckSuppression}\nconst value: number = 'invalid';\n`,
    "test/violations.ts": [
      "declare const candidate: { value?: string } | null;",
      "const implicit = candidate?.value as string;",
      "const asserted: string = <string>implicit;",
      "const definite: string = candidate!.value;",
      "function untyped(input) { return input; }",
      "const arrow: (input: string) => string = (input: string) => input;",
      "class Example { value = 1; }",
      "const escaped: any = implicit;",
      "try { throw new Error('failure'); } catch (error) { console.log(error); }",
      "void asserted; void definite; void arrow; void Example; void escaped;",
      "",
    ].join("\n"),
  });
  try {
    const result: SafetyResult = await runSafety(workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    const assertionViolations: RegExpMatchArray | null = result.stderr.match(
      /Type assertions are forbidden/gu,
    );
    if (assertionViolations === null) throw new Error("Expected assertion violations");
    expect(assertionViolations).toHaveLength(2);
    expect(result.stderr).toContain("Non-null assertions are forbidden");
    expect(result.stderr).toContain("Optional chaining is forbidden");
    expect(result.stderr).toContain("The any type is forbidden");
    expect(result.stderr).toContain("Variable declarations require an explicit type");
    expect(result.stderr).toContain("Parameters require an explicit type");
    expect(result.stderr).toContain("Class properties require an explicit type");
    expect(result.stderr).toContain("Functions and methods require an explicit return type");
    expect(result.stderr).toContain("Catch variables require an explicit unknown type");
    const suppressionViolations: RegExpMatchArray | null = result.stderr.match(
      /TypeScript suppression comments are forbidden/gu,
    );
    if (suppressionViolations === null) throw new Error("Expected suppression violations");
    expect(suppressionViolations).toHaveLength(3);
    expect(result.stderr).toContain("test/expect-error.ts");
    expect(result.stderr).toContain("test/ignore.ts");
    expect(result.stderr).toContain("test/nocheck.ts");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("safety gate fails closed when its census is empty", async (): Promise<void> => {
  const workspace: string = createWorkspace({
    "other/untracked.ts": "export const value: number = 1;\n",
  });
  try {
    const result: SafetyResult = await runSafety(workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("The safety-check census is empty");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("safety gate fails closed when the entry point disappears", async (): Promise<void> => {
  const workspace: string = createWorkspace({
    "scripts/only.ts": "export const value: number = 1;\n",
  });
  try {
    const result: SafetyResult = await runSafety(workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not contain the stdio entry point");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
