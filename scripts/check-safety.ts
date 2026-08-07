import process from "node:process";

import {
  SyntaxKind,
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isCatchClause,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  type LineAndCharacter,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from "typescript/unstable/ast";
import { API, type Project, type Snapshot } from "typescript/unstable/async";

type Violation = {
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

const workspace: string = process.cwd();
const configurationPath: string = `${workspace}/tsconfig.test.json`;
const api: API = new API();
const snapshot: Snapshot = await api.updateSnapshot({ openProjects: [configurationPath] });
const projects: readonly Project[] = snapshot.getProjects();
const project: Project | undefined = projects[0];
if (project === undefined) throw new Error("TypeScript did not load the safety-check project");
const projectFileNames: readonly string[] = await project.program.getSourceFileNames();
const fileNames: readonly string[] = projectFileNames.filter(
  (fileName: string): boolean =>
    fileName.startsWith(`${workspace}/src/`) ||
    fileName.startsWith(`${workspace}/test/`) ||
    fileName.startsWith(`${workspace}/scripts/`),
);
const violations: Violation[] = [];

function report(sourceFile: SourceFile, node: Node, message: string): void {
  const position: LineAndCharacter = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  violations.push({
    column: position.character + 1,
    file: sourceFile.fileName.slice(workspace.length + 1),
    line: position.line + 1,
    message,
  });
}

function isForInitializer(node: VariableDeclaration): boolean {
  const list: Node = node.parent;
  const parent: Node = list.parent;
  return isForInStatement(parent) || isForOfStatement(parent);
}

function visit(sourceFile: SourceFile, node: Node): void {
  if (isAsExpression(node) || isTypeAssertion(node)) {
    report(sourceFile, node, "Type assertions are forbidden; validate or narrow the value.");
  }
  if (isNonNullExpression(node)) {
    report(sourceFile, node, "Non-null assertions are forbidden; narrow the value explicitly.");
  }
  if (
    (isPropertyAccessExpression(node) ||
      isElementAccessExpression(node) ||
      isCallExpression(node)) &&
    node.questionDotToken !== undefined
  ) {
    report(sourceFile, node, "Optional chaining is forbidden; narrow the value explicitly.");
  }
  if (node.kind === SyntaxKind.AnyKeyword) {
    report(sourceFile, node, "The any type is forbidden.");
  }
  if (isVariableDeclaration(node) && node.type === undefined && !isForInitializer(node)) {
    report(sourceFile, node, "Variable declarations require an explicit type.");
  }
  if (isParameterDeclaration(node) && node.type === undefined) {
    report(sourceFile, node, "Parameters require an explicit type.");
  }
  if (isPropertyDeclaration(node) && node.type === undefined) {
    report(sourceFile, node, "Class properties require an explicit type.");
  }
  if (
    (isArrowFunction(node) ||
      isFunctionDeclaration(node) ||
      isFunctionExpression(node) ||
      isGetAccessorDeclaration(node) ||
      isMethodDeclaration(node)) &&
    node.type === undefined
  ) {
    report(sourceFile, node, "Functions and methods require an explicit return type.");
  }
  if (isCatchClause(node) && node.variableDeclaration !== undefined) {
    const declaration: VariableDeclaration = node.variableDeclaration;
    if (declaration.type === undefined) {
      report(sourceFile, declaration, "Catch variables require an explicit unknown type.");
    }
  }
  node.forEachChild((child: Node): void => visit(sourceFile, child));
}

const sourceFiles: SourceFile[] = [];
let fileIndex: number = 0;
while (fileIndex < fileNames.length) {
  const fileName: string | undefined = fileNames[fileIndex];
  if (fileName === undefined) throw new Error("Project file disappeared during iteration");
  const sourceFile: SourceFile | undefined = await project.program.getSourceFile(fileName);
  if (sourceFile === undefined) throw new Error(`TypeScript did not load '${fileName}'`);
  sourceFiles.push(sourceFile);
  fileIndex += 1;
}

sourceFiles.forEach((sourceFile: SourceFile): void => {
  const text: string = sourceFile.getFullText();
  const ignoreDirective: string = "@ts-" + "ignore";
  const expectErrorDirective: string = "@ts-" + "expect-error";
  if (text.includes(ignoreDirective) || text.includes(expectErrorDirective)) {
    report(sourceFile, sourceFile, "TypeScript suppression comments are forbidden.");
  }
  visit(sourceFile, sourceFile);
});

violations.sort((left: Violation, right: Violation): number => {
  const fileOrder: number = left.file.localeCompare(right.file);
  if (fileOrder !== 0) return fileOrder;
  if (left.line !== right.line) return left.line - right.line;
  return left.column - right.column;
});

violations.forEach((violation: Violation): void => {
  console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.message}`);
});

if (violations.length > 0) {
  process.exitCode = 1;
} else {
  console.log(`Safety contract passed for ${fileNames.length} TypeScript files.`);
}

await snapshot.dispose();
await api.close();
