import { type Dir, type Dirent, lstatSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type SourceInput = {
  readonly path: string;
  readonly text: string;
};

export type SourceViolation = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

export type SourceAudit = {
  readonly checkedFiles: number;
  readonly violations: readonly SourceViolation[];
};

const MAXIMUM_FILE_BYTES: number = 1_048_576;
const MAXIMUM_TOTAL_BYTES: number = 8_388_608;
const MAXIMUM_ENTRIES: number = 10_000;
const MAXIMUM_FILES: number = 1_000;
const MAXIMUM_DEPTH: number = 16;
const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set<string>([
  ".astro",
  ".wrangler",
  "coverage",
  "dist",
]);

class SourceAuditError extends Error {}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isForInitializer(node: ts.VariableDeclaration): boolean {
  const parent: ts.Node = node.parent.parent;
  return ts.isForInStatement(parent) || ts.isForOfStatement(parent);
}

function syntaxDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  const options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName: string): boolean => fileName === sourceFile.fileName,
    getCanonicalFileName: (fileName: string): string => fileName,
    getCurrentDirectory: (): string => "/",
    getDefaultLibFileName: (): string => "lib.d.ts",
    getNewLine: (): string => "\n",
    getSourceFile: (fileName: string): ts.SourceFile | undefined =>
      fileName === sourceFile.fileName ? sourceFile : undefined,
    readFile: (): undefined => undefined,
    useCaseSensitiveFileNames: (): boolean => true,
    writeFile: (): void => {
      // Syntax inspection must never emit or modify an authored file.
    },
  };
  // An in-memory host prevents imports, config files, and dependencies from expanding the audit.
  const program: ts.Program = ts.createProgram([sourceFile.fileName], options, host);
  return program.getSyntacticDiagnostics(sourceFile);
}

export function auditSource(input: SourceInput): readonly SourceViolation[] {
  if (input.text.length > MAXIMUM_FILE_BYTES) {
    return [
      {
        path: input.path,
        line: 1,
        column: 1,
        message: "Source file exceeds the bounded audit size.",
      },
    ];
  }
  const violations: SourceViolation[] = [];
  const original: ts.SourceFile = ts.createSourceFile(
    "/murmur-original.ts",
    input.text,
    ts.ScriptTarget.Latest,
  );

  function report(position: number, message: string): void {
    const location: ts.LineAndCharacter = original.getLineAndCharacterOfPosition(position);
    violations.push({
      path: input.path,
      line: location.line + 1,
      column: location.character + 1,
      message,
    });
  }

  for (const suffix of ["ignore", "expect-error", "nocheck"]) {
    const position: number = input.text.indexOf(`@ts-${suffix}`);
    if (position >= 0) report(position, "TypeScript suppression comments are forbidden.");
  }

  let code: string = input.text;
  let codeOffset: number = 0;
  let templateOffset: number = 0;
  const isAstro: boolean = input.path.endsWith(".astro");
  if (isAstro) {
    code = "";
    const opening: RegExpMatchArray | null = input.text.match(/^\uFEFF?---[\t ]*(?:\r?\n|$)/u);
    if (opening !== null) {
      codeOffset = opening[0].length;
      const remaining: string = input.text.slice(codeOffset);
      const closing: RegExpMatchArray | null = remaining.match(/^---[\t ]*(?:\r?\n|$)/mu);
      if (closing === null || closing.index === undefined) {
        report(0, "Astro frontmatter must have a closing delimiter.");
        return violations;
      }
      code = remaining.slice(0, closing.index);
      templateOffset = codeOffset + closing.index + closing[0].length;
    }
    const script: RegExpMatchArray | null = input.text.slice(templateOffset).match(/<script\b/iu);
    if (script !== null && script.index !== undefined) {
      report(
        templateOffset + script.index,
        "Authored Astro script tags are forbidden; use checked TypeScript or React modules.",
      );
    }
  }

  const scriptKind: ts.ScriptKind = input.path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile: ts.SourceFile = ts.createSourceFile(
    scriptKind === ts.ScriptKind.TSX ? "/murmur-source.tsx" : "/murmur-source.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  for (const diagnostic of syntaxDiagnostics(sourceFile)) {
    report(
      codeOffset + (diagnostic.start ?? 0),
      `Invalid TypeScript syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }

  function reportNode(node: ts.Node, message: string): void {
    report(codeOffset + node.getStart(sourceFile), message);
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile).toLowerCase() === "script"
    ) {
      reportNode(
        node,
        "Authored JSX script tags are forbidden; use checked TypeScript or React modules.",
      );
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      reportNode(node, "Type assertions are forbidden; validate or narrow the value.");
    }
    if (
      ts.isNonNullExpression(node) ||
      ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
        node.exclamationToken !== undefined)
    ) {
      reportNode(node, "Non-null assertions are forbidden; narrow the value explicitly.");
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isCallExpression(node)) &&
      node.questionDotToken !== undefined
    ) {
      reportNode(node, "Optional chaining is forbidden; narrow the value explicitly.");
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      reportNode(node, "The any type is forbidden.");
    }
    if (ts.isVariableDeclaration(node) && node.type === undefined && !isForInitializer(node)) {
      reportNode(node, "Variable declarations require an explicit type.");
    }
    if (ts.isParameter(node) && node.type === undefined) {
      reportNode(node, "Parameters require an explicit type.");
    }
    if (ts.isPropertyDeclaration(node) && node.type === undefined) {
      reportNode(node, "Class properties require an explicit type.");
    }
    if (
      (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      node.type === undefined
    ) {
      reportNode(node, "Functions and methods require an explicit return type.");
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      const declaration: ts.VariableDeclaration = node.variableDeclaration;
      if (
        declaration.type === undefined ||
        declaration.type.kind !== ts.SyntaxKind.UnknownKeyword
      ) {
        reportNode(declaration, "Catch variables require an explicit unknown type.");
      }
    }
    ts.forEachChild(node, (child: ts.Node): void => visit(child));
  }

  visit(sourceFile);
  return violations.sort(
    (left: SourceViolation, right: SourceViolation): number =>
      left.line - right.line ||
      left.column - right.column ||
      compareText(left.message, right.message),
  );
}

export function collectSources(workspace: string): readonly SourceInput[] {
  const sources: SourceInput[] = [];
  let entries: number = 0;
  let totalBytes: number = 0;

  function walk(directoryPath: string, relativePath: string, depth: number): void {
    if (depth > MAXIMUM_DEPTH) throw new SourceAuditError("Source census exceeds its depth limit.");
    const directory: Dir = opendirSync(directoryPath);
    try {
      let entry: Dirent | null = directory.readSync();
      while (entry !== null) {
        entries += 1;
        if (entries > MAXIMUM_ENTRIES) {
          throw new SourceAuditError("Source census exceeds its entry limit.");
        }
        const path: string = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        const excluded: boolean =
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          (relativePath === "" && GENERATED_DIRECTORIES.has(entry.name));
        if (!excluded) {
          if (entry.isSymbolicLink()) {
            throw new SourceAuditError(`Source census cannot follow symbolic link '${path}'.`);
          }
          const absolutePath: string = join(directoryPath, entry.name);
          if (entry.isDirectory()) {
            walk(absolutePath, path, depth + 1);
          } else if (entry.isFile() && /\.(?:[cm]?ts|tsx|astro)$/u.test(entry.name)) {
            const size: number = lstatSync(absolutePath).size;
            totalBytes += size;
            if (
              size > MAXIMUM_FILE_BYTES ||
              totalBytes > MAXIMUM_TOTAL_BYTES ||
              sources.length >= MAXIMUM_FILES
            ) {
              throw new SourceAuditError("Source census exceeds its file or byte limit.");
            }
            sources.push({ path, text: readFileSync(absolutePath, "utf8") });
          } else if (entry.isFile() && /\.(?:[cm]?js|jsx)$/u.test(entry.name)) {
            throw new SourceAuditError(
              `Authored JavaScript '${path}' must use checked TypeScript.`,
            );
          }
        }
        entry = directory.readSync();
      }
    } finally {
      directory.closeSync();
    }
  }

  walk(workspace, "", 0);
  return sources.sort((left: SourceInput, right: SourceInput): number =>
    compareText(left.path, right.path),
  );
}

export function auditWebsiteSources(workspace: string): SourceAudit {
  const sources: readonly SourceInput[] = collectSources(workspace);
  if (sources.length === 0) throw new SourceAuditError("The website source census is empty.");
  for (const required of ["astro.config.ts", "src/pages/index.astro"]) {
    if (!sources.some((source: SourceInput): boolean => source.path === required)) {
      throw new SourceAuditError(`The website source census is missing '${required}'.`);
    }
  }
  return {
    checkedFiles: sources.length,
    violations: sources.flatMap((source: SourceInput): readonly SourceViolation[] =>
      auditSource(source),
    ),
  };
}

function main(): void {
  try {
    const audit: SourceAudit = auditWebsiteSources(fileURLToPath(new URL("../", import.meta.url)));
    for (const violation of audit.violations) {
      process.stderr.write(
        `${violation.path}:${violation.line}:${violation.column} ${violation.message}\n`,
      );
    }
    if (audit.violations.length > 0) {
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Website source safety passed for ${audit.checkedFiles} authored files.\n`,
      );
    }
  } catch (error: unknown) {
    const message: string =
      error instanceof SourceAuditError ? error.message : "Source census failed.";
    process.stderr.write(`Website source safety failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
